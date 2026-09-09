export type TmuxLocale = 'en' | 'zh'

const englishTranslations = {
    'settings.title': 'Tmux',
    'settings.defaultSessionName': 'Default session name:',
    'settings.commandTimeout': 'Command timeout (ms):',
    'settings.sendKeysChunkSize': 'Send-keys chunk size:',
    'settings.resizeDebounce': 'Resize debounce (ms):',
    'settings.debugLogging': 'Debug logging:',
    'settings.showCloseButton': 'Show close button on tabs:',
    'mode.enter': 'Enter Tmux Mode',
    'mode.exit': 'Exit Tmux Mode',
    'mode.disconnect': 'Disconnect',
    'pane.copy': 'Copy',
    'pane.paste': 'Paste',
    'pane.split': 'Split',
    'pane.right': 'Right',
    'pane.down': 'Down',
    'pane.left': 'Left',
    'pane.up': 'Up',
    'pane.close': 'Close',
    'pane.rename': 'Rename Pane',
    'pane.renamePrompt': 'Enter a new pane name:',
    'pane.zoom': 'Zoom pane',
    'pane.focusAll': 'Focus all tmux panes',
    'window.current': 'Current window',
    'window.all': 'All windows',
    'window.close': 'Close Window',
    'window.new': 'New Window',
    'window.rename': 'Rename Window',
    'window.renamePrompt': 'Enter a new window name:',
    'window.defaultName': 'Window {{id}}',
    'search.placeholder': 'Search',
    'search.up': 'Search up',
    'search.down': 'Search down',
    'search.caseSensitive': 'Case sensitivity',
    'search.regex': 'Regular expression',
    'search.wholeWord': 'Whole word',
    'search.notFound': 'Not found',
    'common.close': 'Close',
    'zoom.exit': 'Exit zoom',
    'title.pane': 'Pane %{{id}}',
    'title.paneProfile': 'Tmux Pane %{{id}}',
    'title.session': 'Tmux: {{name}}',
    'hotkey.previousWindow': 'Tmux: Previous window',
    'hotkey.nextWindow': 'Tmux: Next window',
    'hotkey.goToWindow': 'Tmux: Go to window {{index}}',
    'hotkey.newWindow': 'Tmux: New window',
    'hotkey.toggleMode': 'Tmux: Toggle tmux mode',
} as const

const chineseTranslations: { [K in keyof typeof englishTranslations]: string } = {
    'settings.title': 'Tmux',
    'settings.defaultSessionName': '默认 session 名称：',
    'settings.commandTimeout': '命令超时（毫秒）：',
    'settings.sendKeysChunkSize': 'Send-keys 分块大小：',
    'settings.resizeDebounce': '调整大小防抖（毫秒）：',
    'settings.debugLogging': '调试日志：',
    'settings.showCloseButton': '在 tab 上显示关闭按钮：',
    'mode.enter': '进入 Tmux 模式',
    'mode.exit': '退出 Tmux 模式',
    'mode.disconnect': '断开连接',
    'pane.copy': '复制',
    'pane.paste': '粘贴',
    'pane.split': '拆分',
    'pane.right': '右侧',
    'pane.down': '下方',
    'pane.left': '左侧',
    'pane.up': '上方',
    'pane.close': '关闭',
    'pane.rename': '重命名 pane',
    'pane.renamePrompt': '请输入新的 pane 名称：',
    'pane.zoom': '缩放 pane',
    'pane.focusAll': '聚焦所有 tmux pane',
    'window.current': '当前 window',
    'window.all': '所有 window',
    'window.close': '关闭 window',
    'window.new': '新建 window',
    'window.rename': '重命名 window',
    'window.renamePrompt': '请输入新的 window 名称：',
    'window.defaultName': 'Window {{id}}',
    'search.placeholder': '搜索',
    'search.up': '向上搜索',
    'search.down': '向下搜索',
    'search.caseSensitive': '区分大小写',
    'search.regex': '正则表达式',
    'search.wholeWord': '全词匹配',
    'search.notFound': '未找到',
    'common.close': '关闭',
    'zoom.exit': '退出缩放',
    'title.pane': 'pane %{{id}}',
    'title.paneProfile': 'Tmux pane %{{id}}',
    'title.session': 'Tmux: {{name}}',
    'hotkey.previousWindow': 'Tmux：上一个 window',
    'hotkey.nextWindow': 'Tmux：下一个 window',
    'hotkey.goToWindow': 'Tmux：前往 window {{index}}',
    'hotkey.newWindow': 'Tmux：新建 window',
    'hotkey.toggleMode': 'Tmux：切换 Tmux 模式',
}

export type TmuxTranslationKey = keyof typeof englishTranslations

type TmuxTranslations = Record<TmuxTranslationKey, string>

const translations: Record<TmuxLocale, TmuxTranslations> = {
    en: englishTranslations,
    zh: chineseTranslations,
}

export function resolveTmuxLocale(language: string | null | undefined): TmuxLocale {
    const normalized = language?.trim().replace(/_/g, '-').toLowerCase()
    return normalized === 'zh' || normalized?.startsWith('zh-') ? 'zh' : 'en'
}

export function translateTmux(
    locale: TmuxLocale,
    key: TmuxTranslationKey,
    params: Record<string, string | number> = {},
): string {
    const template = translations[locale][key] ?? translations.en[key] ?? key
    return template.replace(
        /{{\s*(\w+)\s*}}/g,
        (_, name: string) => `${params[name] ?? `{{${name}}}`}`,
    )
}
