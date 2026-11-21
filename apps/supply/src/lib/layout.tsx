/** The page frame every route draws inside: header, cookie notice, content, footer. A small trade supplier's site: dense, useful, a little dated. */
import type { Child } from 'hono/jsx';
import type { Session } from './shop';

export const FOOTER = 'Offcut Supply is a demo store built for Hack Western 13. Nothing here is for sale.';

const CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:15px;line-height:1.45;color:#1F2328;background:#fff}
a{color:#0B5FFF}
a:hover{text-decoration:none}
header{border-bottom:1px solid #D0D7DE;background:#F6F8FA}
.bar{max-width:1040px;margin:0 auto;padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.brand{font-weight:700;font-size:20px;color:#1F2328;text-decoration:none;margin-right:8px}
.bar form{display:flex;gap:6px;flex:1 1 280px}
main{max-width:1040px;margin:0 auto;padding:18px 16px 48px}
footer{border-top:1px solid #D0D7DE;color:#57606A;font-size:13px}
footer p{max-width:1040px;margin:0 auto;padding:14px 16px}
h1{font-size:24px;margin:6px 0 14px}
h2{font-size:17px;margin:22px 0 8px}
input[type=text],input[type=search],input[type=email],input[type=password],input[type=number]{font:inherit;padding:6px 8px;border:1px solid #D0D7DE;border-radius:6px;min-height:34px;background:#fff;color:inherit}
input[type=search]{flex:1}
input[type=number]{width:84px}
button,.button{font:inherit;font-weight:600;padding:6px 14px;min-height:34px;border-radius:6px;border:1px solid #0B5FFF;background:#0B5FFF;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
button.plain,.button.plain{background:#fff;color:#1F2328;border-color:#D0D7DE}
button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #9CC2FF;outline-offset:1px}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #D0D7DE;vertical-align:top}
th{font-size:13px;color:#57606A;font-weight:600}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:#57606A}
.sku{font-family:ui-monospace,Consolas,monospace;font-size:13px}
.notice{border:1px solid #D0D7DE;border-radius:6px;padding:10px 12px;margin:0 0 14px;background:#F6F8FA}
.error{border-color:#CF222E;background:#FFEBE9}
.good{border-color:#1A7F37;background:#DAFBE1}
.cookie{border-bottom:1px solid #D0D7DE;background:#FFF8C5}
.cookie .bar form{flex:0 0 auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;padding:0;margin:0;list-style:none}
.grid li{border:1px solid #D0D7DE;border-radius:6px;padding:10px 12px}
.stack{display:flex;flex-direction:column;gap:10px;max-width:440px}
fieldset{border:1px solid #D0D7DE;border-radius:6px;padding:10px 12px;margin:0}
label{display:block}
.inline{display:inline-flex;gap:6px;align-items:center}
.totals{max-width:360px;margin-left:auto}
.totals td{border:0;padding:4px 10px}
.totals tr.total td{font-weight:700;border-top:1px solid #D0D7DE;padding-top:8px}
`;

export interface PageProps {
  title: string;
  session: Session;
  cartCount: number;
  cookiesOk: boolean;
  path: string;
  query?: string;
  children?: Child;
}

export function Page(p: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${p.title} | Offcut Supply`}</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        {p.cookiesOk ? null : (
          <div class="cookie" role="region" aria-label="Cookie notice">
            <div class="bar">
              <span>Offcut Supply uses cookies to keep your cart and your sign in.</span>
              <form method="post" action="/cookies">
                <input type="hidden" name="next" value={p.path} />
                <button type="submit" class="plain">Accept cookies</button>
              </form>
            </div>
          </div>
        )}
        <header>
          <div class="bar">
            <a class="brand" href="/">Offcut Supply</a>
            <form method="get" action="/search" role="search">
              <label class="muted" for="q" style="align-self:center">Search</label>
              <input type="search" id="q" name="q" value={p.query ?? ''} placeholder="Name or SKU" />
              <button type="submit">Search</button>
            </form>
            <nav style="display:flex;gap:14px;align-items:center">
              {p.session.signedIn ? <a href="/orders">Orders</a> : null}
              {p.session.signedIn ? (
                <form method="post" action="/signout" style="flex:0 0 auto"><button type="submit" class="plain">Sign out</button></form>
              ) : (
                <a href="/signin">Sign in</a>
              )}
              <a href="/cart">{`Cart (${p.cartCount})`}</a>
            </nav>
          </div>
        </header>
        <main>{p.children}</main>
        <footer><p>{FOOTER}</p></footer>
      </body>
    </html>
  );
}
