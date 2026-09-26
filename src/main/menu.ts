import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'

/**
 * Builds the application menu. Windows and Linux get a conventional layout;
 * macOS gets the platform-standard leading app menu.
 */
export function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Learn More',
          click: () => {
            void shell.openExternal('https://electronjs.org/docs/latest')
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function appDisplayName(): string {
  return app.getName()
}
