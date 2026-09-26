/** Canonical IPC channel names. Keep main, preload and renderer in sync. */
export const IpcChannel = {
  AppGetInfo: 'app:get-info',
  AppPing: 'app:ping',
  WindowSetTitle: 'window:set-title',
  WindowIsMaximized: 'window:is-maximized',
  WindowToggleMaximize: 'window:toggle-maximize',
  WindowClose: 'window:close'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]
