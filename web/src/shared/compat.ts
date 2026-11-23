// 老内核浏览器的兼容补丁，必须在其他模块之前加载（main.tsx 第一行导入）。
// 浏览器版要在只有老浏览器的国产系统上用，如麒麟 V10 SP1 自带的奇安信浏览器（Chromium 83）。
// 语法降级和 JS 内置对象的缺失由 @vitejs/plugin-legacy 处理（见 vite.config.ts），这里只补 DOM 接口。

// Chromium 84 之前 ResizeObserverEntry 没有 borderBoxSize，contentBoxSize 也不是数组。
// 分栏组件（react-resizable-panels）按新规范读取 borderBoxSize[0]，老内核上会报错。
if (typeof ResizeObserverEntry !== 'undefined' && !('borderBoxSize' in ResizeObserverEntry.prototype)) {
  const Native = window.ResizeObserver
  window.ResizeObserver = class extends Native {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        for (const entry of entries) {
          const rect = entry.contentRect
          const el = entry.target as HTMLElement
          const border = { inlineSize: el.offsetWidth ?? rect.width, blockSize: el.offsetHeight ?? rect.height }
          Object.defineProperty(entry, 'borderBoxSize', { value: [border] })
          Object.defineProperty(entry, 'contentBoxSize', { value: [{ inlineSize: rect.width, blockSize: rect.height }] })
        }
        callback(entries, observer)
      })
    }
  }
}

// Chromium 84 之前没有 WeakRef、FinalizationRegistry，SQL 编辑器（Monaco）要用。JS 里做不出真正的弱引用，
// 退化成强引用、不回调：老内核上多占些内存，功能不受影响。
if (typeof WeakRef === 'undefined') {
  class StrongRef<T extends object> {
    constructor(private readonly target: T) {}
    deref(): T {
      return this.target
    }
  }
  Object.defineProperty(globalThis, 'WeakRef', { value: StrongRef, configurable: true, writable: true })
}
if (typeof FinalizationRegistry === 'undefined') {
  class NoopRegistry {
    register(): void {}
    unregister(): boolean {
      return false
    }
  }
  Object.defineProperty(globalThis, 'FinalizationRegistry', { value: NoopRegistry, configurable: true, writable: true })
}

// Chromium 84 之前 flex 布局不支持 gap，元素会挤在一起。量一下是否生效，不生效时给 <html> 加 no-flex-gap，
// shell.css 只为最显眼的几处（状态栏、快捷栏、标签、带图标的按钮）补间距，其他地方只是偏紧。
{
  const probe = document.createElement('div')
  probe.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden'
  probe.append(document.createElement('div'), document.createElement('div'))
  document.documentElement.append(probe)
  if (probe.scrollHeight !== 1) document.documentElement.classList.add('no-flex-gap')
  probe.remove()
}

/** 浏览器不认 :where()（Chromium 88 之前）。antd 样式要换成老内核能用的写法，见 App.tsx。 */
export const LEGACY_CSS = (() => {
  try {
    document.querySelector(':where(a)')
    return false
  } catch {
    return true
  }
})()
