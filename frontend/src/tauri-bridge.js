// Shim that re-implements window.electron (see src/preload.js in the Electron
// build) on top of Tauri's IPC, so renderer.js can run unmodified against
// either shell. window.__TAURI__ is available because tauri.conf.json sets
// app.withGlobalTauri: true.
//
// Phase 1 only wires the non-file-I/O surface (settings/theme/menu). The
// file-I/O channels (save/open/recent/export/drag-drop) are stubbed out here
// and will be filled in during Phase 2/4 — callers get a harmless no-op
// instead of a thrown error so the rest of the app keeps working.
(function () {
  const { core, event } = window.__TAURI__;

  const RECEIVE_CHANNELS = new Set([
    'theme-changed',
    'monaco-settings',
    'save-file-success',
    'save-file-error',
    'request-export-all',
    'file-opened',
    'menu-action',
    'file-changed-externally',
    'file-removed-externally',
    'drop-overlay-show',
    'drop-overlay-hide',
  ]);

  // renderer.js channel name -> Tauri command name for invoke().
  const INVOKE_COMMANDS = {
    'open-file-dialog': 'open_file_dialog',
    'get-recent-files': 'get_recent_files',
    'open-recent-file': 'open_recent_file',
  };

  // renderer.js passes some IPC args as a bare value (Electron style:
  // ipcMain.handle(channel, filePath)) instead of an object. Tauri's
  // core.invoke() requires args as an object whose keys match the Rust param
  // names (camelCased). For these channels we wrap the bare value into the
  // object shape the Rust command expects.
  //   channel -> [argIndex, { wrapperKey: rustParamName }]
  const BARE_ARG_WRAPPERS = {
    'open-recent-file': { key: 'filePath' },
  };

  // renderer.js channel name -> Tauri command name for send() (fire-and-forget).
  const SEND_COMMANDS = {
    'renderer-ready': 'renderer_ready',
    'update-window-title': 'update_window_title',
    'save-file': 'save_file',
    'save-file-to-path': 'save_file_to_path',
    'close-file': 'close_file',
    'open-external': 'open_external',
    // Not yet implemented (Phase 3+): 'set-title-bar-theme',
    // 'export-tabs-data'.
  };

  // Same bare-arg wrapping as above, but for send() channels.
  const SEND_BARE_ARG_WRAPPERS = {
    'close-file': { key: 'filePath' },
    'open-external': { key: 'url' },
  };

  const NOT_YET_IMPLEMENTED_INVOKES = new Set([
    // All Phase 2 file I/O is now implemented
  ]);

  // Convert the args renderer.js passes into the shape Tauri's core.invoke()
  // expects. Tauri requires args as a single object whose keys match the Rust
  // command's parameter names (camelCased). renderer.js follows Electron's
  // convention, which differs per channel:
  //   - most channels pass one object arg  -> pass it through as-is
  //   - some channels pass a bare value     -> wrap it: { [wrapper.key]: value }
  //   - no args                             -> undefined (invoke default {})
  function wrapArgs(wrapper, args) {
    if (args.length === 0) return undefined;
    if (wrapper) {
      return { [wrapper.key]: args[0] };
    }
    return args[0];
  }

  // event.listen() is async — it doesn't actually register with the backend
  // until its Promise resolves. renderer.js calls receive() for every
  // channel synchronously during its require() callback and then sends
  // 'renderer-ready' as the last, also-synchronous statement. Without this
  // tracking, 'renderer-ready' reaches Rust (and Rust emits monaco-settings)
  // before the listener registrations actually land, and the event is lost.
  const pendingListenerRegistrations = [];

  window.electron = {
    receive: (channel, func) => {
      if (!RECEIVE_CHANNELS.has(channel)) {
        console.warn(`tauri-bridge: blocked receive on disallowed channel: ${channel}`);
        return () => {};
      }
      let unlisten = () => {};
      const registered = event.listen(channel, (evt) => func(evt.payload)).then((fn) => {
        unlisten = fn;
      });
      pendingListenerRegistrations.push(registered);
      return () => unlisten();
    },

    send: (channel, ...args) => {
      const command = SEND_COMMANDS[channel];
      if (!command) {
        console.warn(`tauri-bridge: send('${channel}') not yet implemented in the Tauri build, ignoring`);
        return;
      }
      const tauriArgs = wrapArgs(SEND_BARE_ARG_WRAPPERS[channel], args);
      const invoke = () => core.invoke(command, tauriArgs).catch((err) => {
        console.error(`tauri-bridge: send('${channel}') failed:`, err);
      });
      if (channel === 'renderer-ready') {
        // Wait for every receive() registered so far to actually land with
        // the backend before signaling readiness, so Rust's reply emits
        // (e.g. monaco-settings) aren't sent into the void.
        Promise.all(pendingListenerRegistrations).then(invoke);
      } else {
        invoke();
      }
    },

    invoke: (channel, ...args) => {
      const command = INVOKE_COMMANDS[channel];
      if (command) {
        const tauriArgs = wrapArgs(BARE_ARG_WRAPPERS[channel], args);
        return core.invoke(command, tauriArgs);
      }
      if (NOT_YET_IMPLEMENTED_INVOKES.has(channel)) {
        console.warn(`tauri-bridge: invoke('${channel}') not yet implemented in the Tauri build`);
        return Promise.resolve(channel === 'get-recent-files' ? [] : null);
      }
      console.warn(`tauri-bridge: blocked invoke on disallowed channel: ${channel}`);
      return Promise.reject(new Error(`Disallowed channel: ${channel}`));
    },

    openDroppedFiles: () => {
      console.warn('tauri-bridge: openDroppedFiles not yet implemented in the Tauri build');
      return Promise.resolve([]);
    },

    onExportRequest: () => {
      // No 'request-export-all' emits yet (Phase 4); return a no-op unsubscribe.
      return () => {};
    },

    sendExportData: () => {
      console.warn('tauri-bridge: sendExportData not yet implemented in the Tauri build');
    },
  };
})();
