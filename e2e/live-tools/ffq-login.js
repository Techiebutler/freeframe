// Sign in through the real login form without the password passing through a tool call (LIVE-CHROME.md section 2.2, the file
// path). Run on the login page: it adds <input type=file id=pwin>; `upload_file` the mode-0600 password file(s) into it
// (named <account>.pw, inside the workspace), then `window.__ffqLogin('<email>', '<account>')` reads the file in the page,
// fills the form and clicks "Sign in". Returns once the URL has left /login, or after 20 s.
(() => {
  if (window.__ffqLogin) return 'login already installed'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const set = (el, value) => {
    el.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  document.getElementById('pwin')?.remove()
  const i = document.createElement('input')
  i.type = 'file'; i.multiple = true; i.id = 'pwin'
  i.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;width:200px;height:28px;background:#fff'
  document.body.appendChild(i)
  window.__ffqLogin = async (email, account) => {
    const file = Array.from(document.getElementById('pwin').files).find((f) => f.name === account + '.pw')
    if (!file) return { ok: false, why: 'no password file for ' + account }
    const password = (await file.text()).trim()
    const toPassword = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Sign in with password instead')
    if (toPassword) { toPassword.click(); await sleep(400) }
    const emailBox = document.querySelector('input[placeholder="you@example.com"]')
    const pwBox = document.querySelector('input[placeholder="Your password"]')
    if (!emailBox || !pwBox) return { ok: false, why: 'form not found' }
    set(emailBox, email)
    set(pwBox, password)
    await sleep(150)
    document.getElementById('pwin')?.remove()
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Sign in').click()
    for (let n = 0; n < 100 && location.pathname.startsWith('/login'); n++) await sleep(200)
    return { ok: !location.pathname.startsWith('/login'), at: location.pathname }
  }
  return 'login installed'
})()
