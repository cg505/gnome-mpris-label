import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

const mprisInterface = `
<node>
	<interface name="org.mpris.MediaPlayer2.Player">
		<method name="Play" />
		<method name="PlayPause" />
		<method name="Next" />
		<method name="Previous" />
		<method name="Stop" />
		<property name="CanPlay" type="b" access="read" />
		<property name="CanPause" type="b" access="read" />
		<property name="CanGoNext" type="b" access="read" />
		<property name="CanGoPrevious" type="b" access="read" />
		<property name="Metadata" type="a{sv}" access="read"/>
		<property name="PlaybackStatus" type="s" access="read"/>
	</interface>

</node>`

const entryInterface = `
<node>
	<interface name="org.mpris.MediaPlayer2">
		<method name="Raise" />
		<property name="CanRaise" type="b" access="read"/>
		<property name="DesktopEntry" type="s" access="read"/>
		<property name="Identity" type="s" access="read"/>
	</interface>
</node>`

const dBusInterface = `
<node>
	<interface name="org.freedesktop.DBus">
		<method name="ListNames">
			<arg direction="out" type="as"/>
		</method>
		<signal name="NameOwnerChanged">
			<arg direction="out" type="s"/>
			<arg direction="out" type="s"/>
			<arg direction="out" type="s"/>
		</signal>
	</interface>
</node>`

// St resolves CSS background-image URLs with synchronous GIO I/O on the
// compositor's paint path. A remote artUrl (e.g. Spotify's https://i.scdn.co/...)
// gets routed through gvfsd-http and can block gnome-shell indefinitely,
// freezing the entire desktop. Remote art must therefore be downloaded
// asynchronously into a local cache first; only local paths may reach an St style.
const ART_CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(),'mpris-label','album-art']);
const ART_DOWNLOAD_TIMEOUT = 15;//seconds, per-connection stall timeout
const ART_RETRY_COOLDOWN = 300000;//milliseconds between retries of a failed url
const ART_CACHE_MAX_AGE_DAYS = 30;

let artSession = null;
const artDownloadsInFlight = new Set();
const artDownloadsFailed = new Map();//url -> timestamp of last failure

function getLocalArtUrl(url){
	const scheme = GLib.uri_parse_scheme(url);

	if(scheme == null || scheme == 'file' || scheme == 'resource')
		return url

	if(scheme != 'http' && scheme != 'https')
		return null //can't load this safely, treat as "no art"

	const filename = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256,url,-1);
	const cachePath = GLib.build_filenamev([ART_CACHE_DIR,filename]);

	if(GLib.file_test(cachePath,GLib.FileTest.EXISTS))
		return 'file://' + cachePath

	downloadArt(url,cachePath);
	return null //show the fallback icon until the download lands in the cache
}

function downloadArt(url,cachePath){
	if(artDownloadsInFlight.has(url))
		return

	const failedAt = artDownloadsFailed.get(url);
	if(failedAt && new Date().getTime() - failedAt < ART_RETRY_COOLDOWN)
		return

	const message = Soup.Message.new('GET',url);
	if(!message){
		artDownloadsFailed.set(url,new Date().getTime());
		return
	}

	if(!artSession){
		artSession = new Soup.Session({timeout: ART_DOWNLOAD_TIMEOUT});
		pruneArtCache();
	}

	artDownloadsInFlight.add(url);
	artSession.send_and_read_async(message,GLib.PRIORITY_DEFAULT,null,(session,result) => {
		artDownloadsInFlight.delete(url);
		try{
			const bytes = session.send_and_read_finish(result);

			if(message.get_status() != Soup.Status.OK || !bytes || bytes.get_size() == 0)
				throw new Error('HTTP status ' + message.get_status());

			GLib.mkdir_with_parents(ART_CACHE_DIR,0o700);
			GLib.file_set_contents(cachePath,bytes.get_data());
			artDownloadsFailed.delete(url);
		}
		catch(err){
			if(!(err instanceof GLib.Error && err.matches(Gio.io_error_quark(),Gio.IOErrorEnum.CANCELLED))){
				artDownloadsFailed.set(url,new Date().getTime());
				log('Mpris Label: album art download failed: ' + err);
			}
		}
	});
}

function pruneArtCache(){
	const dir = Gio.File.new_for_path(ART_CACHE_DIR);
	dir.enumerate_children_async('standard::name,time::modified',Gio.FileQueryInfoFlags.NONE,GLib.PRIORITY_LOW,null,(source,result) => {
		let enumerator;
		try{
			enumerator = source.enumerate_children_finish(result);
		}
		catch{
			return //cache dir doesn't exist yet
		}

		const cutoff = new Date().getTime()/1000 - ART_CACHE_MAX_AGE_DAYS*86400;
		enumerator.next_files_async(1000,GLib.PRIORITY_LOW,null,(enumSource,enumResult) => {
			let infos = [];
			try{
				infos = enumSource.next_files_finish(enumResult);
			}
			catch{
				; //do nothing
			}
			infos.forEach(info => {
				const modified = info.get_modification_date_time();
				if(modified && modified.to_unix() < cutoff)
					dir.get_child(info.get_name()).delete_async(GLib.PRIORITY_LOW,null,null);
			});
			enumerator.close_async(GLib.PRIORITY_LOW,null,null);
		});
	});
}

export function stopArtDownloads(){
	if(artSession){
		artSession.abort();
		artSession = null;
	}
	artDownloadsInFlight.clear();
	artDownloadsFailed.clear();
}

export var Players = class Players {
	constructor(settings){
		this.list = [];
		this.activePlayers= [];
		const dBusProxyWrapper = Gio.DBusProxy.makeProxyWrapper(dBusInterface);
		this.dBusProxy = dBusProxyWrapper(Gio.DBus.session,"org.freedesktop.DBus","/org/freedesktop/DBus",this._initList.bind(this));
		this.settings = settings;
	}
	pick(){
		const AUTO_SWITCH_TO_MOST_RECENT = this.settings.get_boolean('auto-switch-to-most-recent');

		if(this.list.length == 0){
			this.selected = null;
			return this.selected
		}

		if(!this.list.includes(this.selected))
			this.selected = null

		if(this.list.includes(this.selected) && !AUTO_SWITCH_TO_MOST_RECENT)
			return this.selected

		let newestTimestamp = 0;
		let bestChoice = this.list[0];
		let list = this.list;

		if(AUTO_SWITCH_TO_MOST_RECENT){
			if(this.activePlayers.length == 0)
				return this.selected

			list = this.activePlayers;
		}

		list.forEach(player => {
			if(player.statusTimestamp > newestTimestamp){
				newestTimestamp = player.statusTimestamp;
				bestChoice = player;
			}
		});
		this.selected = bestChoice;
		return this.selected
	}
	next(){
		const AUTO_SWITCH_TO_MOST_RECENT = this.settings.get_boolean('auto-switch-to-most-recent');

		let list = this.list;

		if(AUTO_SWITCH_TO_MOST_RECENT)
			list = this.activePlayers;

		if(list.length < 2)
			return this.selected

		let newIndex = list.indexOf(this.selected)+1;

		if(this.selected == list[list.length-1])
			newIndex = 0;

		this.selected = list[newIndex];

		if(AUTO_SWITCH_TO_MOST_RECENT){
			this.selected.statusTimestamp = new Date().getTime();
		}

		return this.selected
	}
	_initList(){
		let dBusList = this.dBusProxy.ListNamesSync()[0];
		dBusList = dBusList.filter(element => element.startsWith("org.mpris.MediaPlayer2"));

		this.unfilteredList = [];
		dBusList.forEach(address => this.unfilteredList.push(new Player(address)));

		this.dBusProxy.connectSignal('NameOwnerChanged',this._updateList.bind(this));
	}
	_updateList(proxy, sender, [name,oldOwner,newOwner]){
		if(name.startsWith("org.mpris.MediaPlayer2")){
			if(newOwner && !oldOwner){ //add player
				let player = new Player(name);
				this.unfilteredList.push(player);
			}
			else if (!newOwner && oldOwner){ //delete player
				this.unfilteredList = this.unfilteredList.filter(player => player.address != name);
			}
		}
	}
	updateFilterList(){
		if(!this.unfilteredList)
			return

		const SOURCES_BLACKLIST = this.settings.get_string('mpris-sources-blacklist');
		const SOURCES_WHITELIST = this.settings.get_string('mpris-sources-whitelist');
		let USE_WHITELIST = this.settings.get_boolean('use-whitelisted-sources-only');

		if(!SOURCES_BLACKLIST || !SOURCES_WHITELIST)
			this.list = this.unfilteredList;

		const blacklist = SOURCES_BLACKLIST.toLowerCase().replaceAll(' ','').split(',');
		const whitelist = SOURCES_WHITELIST.toLowerCase().replaceAll(' ','').split(',');

		if(USE_WHITELIST && SOURCES_WHITELIST)
			this.list = this.unfilteredList.filter(element => whitelist.includes(element.identity.toLowerCase().replaceAll(' ','')));

		if(!USE_WHITELIST && SOURCES_BLACKLIST)
			this.list = this.unfilteredList.filter(element => !blacklist.includes(element.identity.toLowerCase().replaceAll(' ','')));
	}
	updateActiveList(){
		let actives = [];
		this.list.forEach(player => {
			if(player.playbackStatus == "Playing")
				actives.push(player);
		});
		this.activePlayers = actives;
	}
}

class Player {
	constructor(address){
		this.address = address;
		this.statusTimestamp = new Date().getTime();
		this.albumArt = null;

		const proxyWrapper = Gio.DBusProxy.makeProxyWrapper(mprisInterface);
		this.proxy = proxyWrapper(Gio.DBus.session,this.address, "/org/mpris/MediaPlayer2",this.update.bind(this));
		this.proxy.connect('g-properties-changed', this.update.bind(this));

		const entryWrapper = Gio.DBusProxy.makeProxyWrapper(entryInterface);
		this.entryProxy = entryWrapper(Gio.DBus.session,this.address, "/org/mpris/MediaPlayer2",this._onEntryProxyReady.bind(this));

	}
	_onEntryProxyReady(){
		this.identity = this.entryProxy.Identity;
		this.desktopEntry = this.entryProxy.DesktopEntry;
		this.canRaise = this.entryProxy.CanRaise;

		this.desktopApp = null;
		let matchedEntries = [];
		if(! (this.identity == null | undefined))
			matchedEntries = GioUnix.DesktopAppInfo.search(this.identity);

		if ( matchedEntries.length === 0 && !(this.desktopEntry == null | undefined) )//backup method using DesktopEntry info
			matchedEntries = GioUnix.DesktopAppInfo.search(this.desktopEntry);

		//de-nest matchedEntries. GioUnix.DesktopAppInfo.search returns a nested array
		let entries = [];
		matchedEntries.forEach(nest => {
			nest.forEach(entry => {
				entries.push(entry);
			});
		});
		matchedEntries = entries;

		if ( matchedEntries.length > 0 )
			this.desktopApp = this._matchRunningApps(matchedEntries)

		this.icon = this.getIcon();
	}
	_matchRunningApps(matchedEntries){
		const activeApps = Shell.AppSystem.get_default().get_running();

		const match = matchedEntries.find(entry => {
			let playerObject = Shell.AppSystem.get_default().lookup_app(entry);
			return activeApps.includes(playerObject)
		});

		if(match)
			return match

		return matchedEntries[0]
	}
	update(){
		this.metadata = this.proxy.Metadata;

		let playbackStatus = this.proxy.PlaybackStatus;

		if(this.playbackStatus != playbackStatus){
			this.playbackStatus = playbackStatus;
			this.statusTimestamp = new Date().getTime();
		}
	}
	stringFromMetadata(field) {
		// metadata is a javascript object
		// each "field" correspond to a string-keyed property on metadata
		// each property contains a GLib.Variant object
		if (Object.keys(this.metadata).includes(field)){
			let variant = this.metadata[field];

			if(variant.get_type().is_array())
				return variant.get_strv()[0]
			else
				return variant.get_string()[0]
		}
		return ""
	}
	getArtUrlIcon(size,radius){
		const url = this.stringFromMetadata("mpris:artUrl",this.metadata);
		let localUrl = null;

		if(url.length>0)
			localUrl = getLocalArtUrl(url);//never returns a remote url (see above)

		if(localUrl){
			const cssUrl = localUrl.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
			let innerArt = new St.Bin({
				style: `
					border-radius: ${radius}px;
					overflow: hidden;
					padding: 0px;
					width: ${size}px;
					height: ${size}px;
					background-image: url('${cssUrl}');
					background-size: cover;
					background-position: center;
				`,
			});
			this.albumArt = new St.Bin();
			this.albumArt.set_child(innerArt);
		}
		else this.albumArt = null;

		return this.albumArt
	}
	getIcon(){
		let icon = new St.Icon({
			style_class: 'system-status-icon',
			fallback_icon_name: 'audio-volume-high'
		});

		if(this.desktopApp == null | undefined)
			return icon

		let entry = GioUnix.DesktopAppInfo.new(this.desktopApp);
		let gioIcon = entry.get_icon();
		icon.set_gicon(gioIcon);
		return icon
	}
	toggleStatus() {
		if (this.proxy.CanPlay && this.proxy.CanPause){
			this.proxy.PlayPauseRemote();
			return
		}
		//workaround for some players (Plexamp) which incorrectly change CanPause set to false when paused
		if (this.proxy.CanPlay && this.proxy.PlaybackStatus == "Paused"){ 
			this.proxy.PlayRemote();
			return
		}
		if (this.proxy.PlaybackStatus == "Playing"){ // fallback to "Stop"
			this.proxy.StopRemote();
			return
		}
	}
	raise() { //activate source app / browser tab
		this.entryProxy.RaiseAsync();
	}
	goNext(){
		if (this.proxy.CanGoNext)
			this.proxy.NextRemote()
	}
	goPrevious(){
		if (this.proxy.CanGoPrevious)
			this.proxy.PreviousRemote()
	}
	activatePlayer(){
		let focusedWindow = global.display.get_focus_window();
		let playerWindow = this._matchAppWindow();
		let currentWorkspace = global.workspace_manager.get_active_workspace();

		if (!playerWindow){
			if (this.canRaise){
				this.previousWorkspace = currentWorkspace;
				this.previousWindow = focusedWindow;
				this.raisedFromBackground = true;
				this.raise();
			}
			return;
		}

		if (focusedWindow == playerWindow){
			if (this.raisedFromBackground){
				this.raisedFromBackground = false;
				playerWindow.delete(global.get_current_time());
				return;
			}
			if (currentWorkspace == this.previousWorkspace){ //go back to last workspace
				if (this.playerWindowMinimized)
					playerWindow.minimize();

				this.previousWindow.activate(global.get_current_time());
			}
			else if (this.previousWorkspace)//focus window on current workspace
				this.previousWorkspace.activate(global.get_current_time());
		}
		else{
			this.raisedFromBackground = false;
			if(this.desktopApp){
				this.previousWorkspace = currentWorkspace;
				this.previousWindow = focusedWindow;
				this.playerWindowMinimized = playerWindow.minimized;
				playerWindow.activate(global.get_current_time());
				if (this.canRaise) //try to raise player window/tab using mpris if available
					this.raise();
			}
		}
	}
	_matchAppWindow(){//match player with window
		let app = Shell.AppSystem.get_default().lookup_app(this.desktopApp);
		let appPID = app.get_pids();

		let windows_list = global.display.get_window_actors();
		windows_list = windows_list.filter(element => element.get_meta_window().get_window_type() == 0); //only keep normal windows
		
		for (const actor of windows_list) {//match window based on pid
			const window = actor.get_meta_window();
			let windowPID = window.get_pid();
			if (appPID.includes(windowPID))
				return window;
		}
	}
}

