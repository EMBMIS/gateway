/**
 * Inside the EMBMIS desktop app the Gateway console is one product in a native window. The desktop draws the frame
 * (navigation, breadcrumb, search, account, theme); this page draws only the page and tells the desktop what the
 * frame needs. `window.embmisDesktop` exists only in the desktop app (its preload), never in a browser.
 *   publish(state)   navigation, where you are, who you are, how many decisions wait for a person
 *   onCommand(fn)    navigate, sign out, keyboard help, search (answered with reply(id, results))
 * Presentation only: the desktop trusts none of it for security.
 */
export const desktop = typeof window !== 'undefined' && window.embmisDesktop && typeof window.embmisDesktop.publish === 'function'
  ? window.embmisDesktop
  : null

export const inDesktop = !!desktop
