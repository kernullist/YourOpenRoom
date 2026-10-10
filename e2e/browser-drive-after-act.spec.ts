import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

import {
  startAoiBrowserDriveSession,
  type AoiBrowserDriveSession,
} from '../apps/webuiapps/src/lib/aoiBrowserDriveSession';
import {
  executeAoiBrowserDriveStep,
  type AoiBrowserDriveActablePage,
  type AoiBrowserDriveStepResult,
} from '../apps/webuiapps/src/lib/aoiBrowserDriveExecutor';
import { executeAoiBrowserDriveActStep } from '../apps/webuiapps/src/lib/aoiBrowserDriveActRunner';
import { addAoiBrowserDriveAllowlistEntry } from '../apps/webuiapps/src/lib/aoiBrowserDriveAllowlist';
import type { AoiBrowserDriveActionRequest } from '../apps/webuiapps/src/lib/aoiBrowserDriveAction';
import { resolveAoiHostBrowserExecutable } from '../apps/webuiapps/src/lib/aoiHostBrowserRead';

// The installed Chrome or Edge, headless, on a throwaway profile: the look
// after an act reads what a real browser renders, and the dialog behavior under
// test is the real browser's.
const systemBrowser = resolveAoiHostBrowserExecutable();

// A public-looking site served from here, so nothing touches the network and
// the denylist sees an ordinary host (it refuses localhost by design).
const SHOP = 'https://shop.example/';
const SHOP_PAGE = `<!doctype html><title>Shop</title><body>
<p id="status">Your cart is empty</p>
<button id="add" onclick="setTimeout(function () {
  document.getElementById('status').textContent = 'Added to cart';
}, 150)">Add</button>
<button id="empty" onclick="if (confirm('Empty the cart?')) {
  document.getElementById('status').textContent = 'Emptied';
}">Empty</button>
<button id="details" onclick="setTimeout(function () {
  history.pushState({}, '', '/details');
  document.getElementById('status').textContent = 'Item details';
}, 200)">Details</button>
<button id="leave" onclick="setTimeout(function () {
  location.href = 'https://evil.example/phish';
}, 100)">Leave</button>
</body>`;
const DENIED_PAGE = '<!doctype html><title>Sign in</title><body>Enter your password</body>';
// A checkout form, a field that belongs to it from outside, and an ordinary
// search form: what Enter submits is read off the form a field belongs to.
const PAY = 'https://shop.example/pay';
// The harder cases: what HTML itself decides an act reaches.
const HARD = 'https://shop.example/hard';
const HARD_PAGE = `<!doctype html><title>Hard</title><body>
<form id="sf" onsubmit="document.title='SUBMIT:own'; return false;">
<input id="amt1" aria-label="Amount"><div id="host"></div><button id="own">Pay now</button>
</form>
<iframe id="fr" srcdoc="<form onsubmit=&quot;parent.document.title='SUBMIT:frame'; return false;&quot;><input id=amt2 aria-label=Amount><button>Pay now</button></form>"></iframe>
<form id="nf" onsubmit="document.title='SUBMIT:form-itself'; return false;">
<h3>Confirm payment of $500</h3><input id="amt3" aria-label="Amount">
</form>
<button id="next" onclick="document.title='PAID'">Continue</button>
<div id="ov" style="position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.05)"></div>
<label>Note <span id="note" contenteditable=" false">x</span><input id="pw2" type="password" autocomplete="current-password"></label>
<form id="pf" onsubmit="document.title='SUBMIT:pay'; return false;">
<input id="amt5" aria-label="Card amount"><button>Pay now</button>
</form>
<input id="dis" disabled aria-label="Coupon">
<div id="tbox" tabindex="0" onkeydown="if (event.key === ' ') document.title = 'PAID';">Pay now</div>
<input type="checkbox" id="oneclick" onchange="document.title='PAID'"><label for="oneclick">Buy now with one click</label>
<div onclick="document.title='PAID'"><span id="price">$19.99</span> Buy now</div>
<div onclick="document.title='PAID'"><svg id="mute" width="10" height="10"></svg><span style="position:absolute;left:-9999px">Buy now and get free shipping on every order placed before midnight tonight, today only</span></div>
<div onclick="document.title='PAID'"><svg id="mute2" width="10" height="10"></svg><span>Free shipping on every order placed before midnight tonight, today only, on all items in the store</span></div>
<table><form id="tf" onsubmit="document.title='SUBMIT:table'; return false;"><tr><td><input id="amt4" aria-label="Amount"></td><td><button>Pay now</button></td></tr></form></table>
<script>
document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button id="sb">Search</button>';
document.getElementById('amt5').focus();
setTimeout(function () {
  document.getElementById('ov').remove();
  document.getElementById('next').textContent = 'Pay now';
}, 2500);
</script>
</body>`;
// Elements a selector names that are not the element the act reaches.
const REACH = 'https://shop.example/reach';
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
const REACH_PAGE = `<!doctype html><title>Reach</title><body>
<label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password">
<label>Card number <input id="cc" autocomplete="cc-number"></label>
<label for="paybtn">Continue</label><button id="paybtn" onclick="document.title='PAID'">Pay now</button>
<button id="checkout" onclick="document.title='ORDERED'"><i class="icon">*</i> Place order</button>
<input type="image" id="buyimg" alt="Buy now" src="${PIXEL}" onclick="document.title='BOUGHT'; return false;">
<button id="imgbtn" onclick="document.title='PAID'"><img alt="Pay now" src="${PIXEL}"></button>
<h2 id="heading">Checkout</h2>
<form id="payform" onsubmit="document.title='SUBMITTED'; return false;">
<input id="auto" aria-label="Note"><button type="pay">Pay now</button>
</form>
<input id="cardNo" placeholder="카드번호">
<button id="later" disabled onclick="document.title='LATE'">Continue</button>
<button id="details" onclick="document.title='DETAILS'">Show details</button>
<script>
document.getElementById('auto').focus();
setTimeout(function () {
  var later = document.getElementById('later');
  later.disabled = false;
  later.textContent = 'Pay now';
}, 1500);
</script>
</body>`;
const PAY_PAGE = `<!doctype html><title>Pay</title><body>
<form id="checkout" onsubmit="document.title = 'submitted'; return false;">
<label>Card holder <input id="holder"></label>
<button>Pay now</button>
</form>
<input id="qty" form="checkout" aria-label="Quantity">
<form onsubmit="document.title = 'searched'; return false;">
<input id="q" aria-label="Search"><button>Search</button>
</form>
<form id="shopsearch" onsubmit="document.title = 'shop searched'; return false;">
<h2>Proceed to checkout</h2>
<input id="find" aria-label="Find a product"><button>Search</button><button>Buy now</button>
</form>
<button form="shopsearch" type="submit">Place order</button>
</body>`;

// What an element's own tree, a frame with focus, a component that passes focus
// on, and the browser's own default button decide about where an act lands.
const TREES = 'https://shop.example/trees';
const TREES_PAGE = `<!doctype html><title>Trees</title><body>
<x-a id="sh"><template shadowrootmode="open">
<label for="f1">Password</label><div><input id="f1"></div>
<span id="l1">Card number</span><input id="f2" aria-labelledby="l1">
<label id="lb" for="s">Continue</label>
<input type="submit" id="s" value="Pay now" onclick="document.title='PAID'; return false;">
</template></x-a>
<div id="notes" style="width:200px;height:30px">Notes</div>
<iframe id="pf" srcdoc="<form onsubmit=&quot;parent.document.title='SUBMIT:frame'; return false;&quot;><input id=zip aria-label=ZIP><button>Pay now</button></form>"></iframe>
<x-f id="df"><template shadowrootmode="open" shadowrootdelegatesfocus>
<form onsubmit="document.title='SUBMIT:df'; return false;"><input id="dfi"><button>Pay now</button></form>
</template></x-f>
<x-f id="ds"><template shadowrootmode="open" shadowrootdelegatesfocus>
<form onsubmit="document.title='SUBMIT:ds'; return false;"><input id="dsi"><button>Search</button></form>
</template></x-f>
<table>
<form onsubmit="document.title='SUBMIT:a'; return false;"><tr><td><input id="ta"></td><td><button>Search</button></td></tr></form>
<form onsubmit="document.title='SUBMIT:b'; return false;"><tr><td><input id="tb"></td><td><button>Log in</button></td></tr></form>
<form onsubmit="document.title='SUBMIT:c'; return false;"><tr><td><input id="tc"></td><td><button>Subscribe</button></td></tr></form>
<form onsubmit="document.title='SUBMIT:d'; return false;"><tr><td><input id="td" aria-label="Amount"></td><td><button>Pay now</button></td></tr></form>
</table>
<div onclick="document.title='PAID'" style="cursor:pointer"><div><div><div><div><div><span>›</span><i id="deep" style="display:inline-block;width:12px;height:12px;background:#000"></i></div></div></div></div></div><span>Buy now</span></div>
<div><span>Pay now</span><button id="mute" onclick="document.title='PAID'"><svg width="10" height="10"></svg></button></div>
<form onsubmit="document.title='SUBMIT:hidden'; return false;"><input id="hid" aria-label="Amount"><button style="visibility:hidden">Pay now</button></form>
<div id="menu" onmouseover="document.title='HOVERED'" style="width:20px;height:20px;padding:10px"><svg width="16" height="16"><rect width="16" height="16"></rect></svg></div>
<input id="mv" onfocus="setTimeout(function () { document.getElementById('paymv').focus(); }, 30)">
<button id="paymv" onclick="document.title='PAID'">Pay now</button>
</body>`;
// A page wrapped in one form, the way ASP.NET builds them, whose first submit
// control is an icon-only search button.
const WEBFORM = 'https://shop.example/webform';
const WEBFORM_PAGE = `<!doctype html><title>Webform</title><body>
<form id="aspnetForm" onsubmit="document.title='SUBMIT:' + (event.submitter ? event.submitter.id : 'form'); return false;">
<nav><a href="/">Home</a> <a href="/shop">Shop</a> <a href="/cart">Cart</a> <a href="/checkout">Checkout</a></nav>
<div><input id="aq" placeholder="Search products"><input type="image" id="go" src="${'data:image/gif;base64,R0lGODlhAQABAAAAACw='}" width="16" height="16"></div>
<main><h1>Welcome</h1><p>Browse the catalogue: lamps, rugs, chairs, tables and shelves, all
in stock and shipped within two days of your order.</p></main>
</form>
</body>`;
// Links to a page that takes seconds to answer.
const SLOW = 'https://shop.example/slow';
const SLOW_START = 'https://shop.example/slowstart';
const SLOW_START_PAGE = `<!doctype html><title>Slow</title><body>
<a id="go" href="/slow">Next page</a>
</body>`;
// Ordinary clicks a covered check must not hold up: a link that wraps onto two
// lines, a button that lands under a fixed header.
const COVER = 'https://shop.example/cover';
const COVER_PAGE = `<!doctype html><title>Cover</title><body style="margin:0">
<div style="position:fixed;top:0;left:0;right:0;height:120px;background:#333;color:#fff;z-index:9">Header</div>
<p style="width:300px;font:20px/30px monospace;margin:130px 0 0">xxxxxxxxxxxxxxxxxxxxx <a id="wrap" href="#done" onclick="document.title='WRAPPED'">abc def</a> yyyyyyyyyyyyyyy</p>
<div style="height:1000px"></div><button id="more" onclick="document.title='MORE'">Show more</button><div style="height:3000px"></div>
<script>addEventListener('load', function () { scrollTo(0, 1060); });</script>
</body>`;

// What components draw in their own trees, and what the parser decides.
const DRAWN = 'https://shop.example/drawn';
const FILLER = `<p>${'Free returns within thirty days on every order, no questions asked. '.repeat(3)}</p>`;
const DRAWN_PAGE = `<!doctype html><title>Drawn</title><body>
${FILLER}
<main><h2>Summary</h2><p>Item #4821</p>
<button id="drawn" onclick="document.title='PAID'"><i18n-t><template shadowrootmode="open">Pay now</template></i18n-t></button></main>
<div onclick="document.title='PAID'" style="cursor:pointer"><x-price><template shadowrootmode="open"><span id="price">$19.99</span></template></x-price> <span>Buy now</span></div>
<div class="row">Total $19.99 <pay-button id="sealed" style="display:inline-block;width:80px;height:20px"><template shadowrootmode="closed"><button onclick="document.title='PAID'">Pay $19.99</button></template></pay-button></div>
<sl-button id="save"><template shadowrootmode="open"><button onclick="document.title='SAVED'"><slot></slot></button></template>Save</sl-button>
<form id="Z" onsubmit="document.title='SUBMIT:Z'; return false;"><button>Search</button><div></form>
<table><form id="Y" onsubmit="document.title='SUBMIT:Y'; return false;"><tr><td><input id="owned" aria-label="Amount"></td></tr></table></div>
<button id="ypay">Pay now</button>
</body>`;
// The same traps served as XHTML, whose elements no plain XPath name matches.
const XHTML = 'https://shop.example/xhtml';
const XHTML_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Xhtml</title></head><body>
<label for="xpw">Password</label><input id="xpw" type="password"/>
<label for="xpay">Continue</label><button id="xpay" onclick="document.title='PAID'">Pay now</button>
<form onsubmit="document.title='SEARCHED'; return false;"><input id="xq" aria-label="Search"/><button>Search</button></form>
</body></html>`;

// What is no word, what holds something nothing reads, and what the page's
// own objects can be made to say.
const WORDS = 'https://shop.example/words';
const WORDS_PAGE = `<!doctype html><title>Words</title>
<style>.cart::before { content: "\\f07a"; font-family: serif; }</style><body>
${FILLER}
<div><span>Buy now</span> <button id="glyph" onclick="document.title='PAID'"><i class="cart"></i></button></div>
<form onsubmit="document.title='SUBMIT:unnamed'; return false;"><div>Pay $19.99 <input type="submit" id="unnamed"></div></form>
<div id="panel" style="display:flex;flex-direction:column;align-items:center">
<p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(13)}</p>
<button style="width:300px;height:60px" onclick="document.title='PAID'">Pay now</button>
<p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(13)}</p></div>
<div>Total $19.99 <button id="holds" onclick="document.title='PAID'"><x-pay><template shadowrootmode="closed"><span>Pay</span></template></x-pay></button></div>
<div>Total $19.99 <pay-label id="bracket"><template shadowrootmode="open"><button onclick="document.title='PAID'">[Pay now]</button></template></pay-label></div>
<label for="cardf"><i18n-t><template shadowrootmode="open">Card number</template></i18n-t></label> <input id="cardf" name="f1">
<div><span>Add to wishlist</span> <button id="liked" onclick="document.title='LIKED'"><fa-icon><svg width="12" height="12"><path d="M0 0h12v12H0z"></path></svg></fa-icon></button></div>
<div>Total $19.99 <button id="emptyspan" onclick="document.title='PAID'"><x-pay><template shadowrootmode="closed"><span>Pay</span></template><span></span></x-pay></button></div>
<div class="bar"><button id="menu" onclick="document.title='MENU'"><svg width="10" height="10"></svg></button> <span>Menu</span>
<mini-cart><template shadowrootmode="open"><span>Checkout (2)</span></template></mini-cart></div>
<form id="aspnet" onsubmit="return false;"><img name="matches" alt="">
<div onclick="document.title='PAID'" style="cursor:pointer"><x-price><template shadowrootmode="open"><span id="price">$19.99</span></template></x-price> <span>Buy now</span></div>
</form>
</body>`;
// What the browser itself finds where a click lands: a component that draws
// where no read reaches, a link around a button, an image map, frames from
// other sites, a player in a button, a label for a hidden button, an icon its
// stylesheet draws.
const AIMED = 'https://shop.example/aimed';
const AIMED_PAGE = `<!doctype html><title>Aimed</title>
<style>.heart::before { content: "\\f004"; display: inline-block; width: 16px; height: 16px; }</style>
<script>
customElements.define('x-wallet', class extends HTMLElement { constructor() { super();
  const root = this.attachShadow({ mode: 'closed' });
  root.innerHTML = '<span style="display:inline-block;width:280px;height:60px;background:#000;color:#fff">Pay $19.99</span>';
  this.addEventListener('click', () => { document.title = 'PAID'; }); } });
addEventListener('message', (event) => { document.title = String(event.data); });
</script><body>
${FILLER}
<div id="wallet" style="display:flex;flex-direction:column;align-items:center;width:400px"><p>Or use your wallet</p><x-wallet></x-wallet><p>Fast and secure</p></div>
<p><a href="/checkout/buy-now" onclick="document.title='BOUGHT'; return false;">Buy now <button type="button" id="details">Details</button></a></p>
<p>Today's deal <img id="map" usemap="#deal" width="100" height="40" src="${PIXEL}"><map name="deal"><area shape="rect" coords="0,0,100,40" href="#" alt="Buy now" onclick="document.title='BOUGHT'; return false;"></map></p>
<iframe id="payframe" title="Card details" src="https://psp.example/pay" style="width:320px;height:90px;border:0"></iframe>
<iframe id="player" title="Video player" src="https://player.example/embed" style="width:400px;height:240px;border:0"></iframe>
<p><button id="paybox" onclick="document.title='PAID'">Pay now <video id="vid" controls width="160" height="90"></video></button></p>
<p><a id="forgot" href="#" onclick="document.title='FORGOT'; return false;">Forgot password?</a></p>
<div id="options" style="display:flex;flex-direction:column;align-items:center;width:400px"><p>${'Shipping options and delivery times. '.repeat(4)}</p>
<label for="hiddenpay" style="display:block;width:200px;height:40px">Continue</label><p>${'Shipping options and delivery times. '.repeat(4)}</p></div>
<button id="hiddenpay" style="display:none" onclick="document.title='PAID'">Pay now</button>
<div><span>Add to wishlist</span> <button id="heart" onclick="document.title='LIKED'"><fa-icon class="heart"></fa-icon></button></div>
<iframe id="own" src="/ownframe" style="width:400px;height:80px;border:0"></iframe>
</body>`;
// A frame of the page's own, where the browser is not asked: a pay component
// behind a space nobody sees.
const OWN_FRAME = 'https://shop.example/ownframe';
const OWN_FRAME_PAGE = `<!doctype html><title>Own</title><body>
<div>Fast and secure <x-pay2 id="sp" onclick="parent.document.title='PAID'"><template shadowrootmode="closed"><span style="display:inline-block;padding:8px 24px;background:#000;color:#fff">Pay $19.99</span></template>&nbsp;</x-pay2></div>
</body>`;
const PAY_FRAME_PAGE = `<!doctype html><body style="margin:0"><button style="width:100%;height:100vh" onclick="parent.postMessage('PAID', '*')">Pay now $49.00</button></body>`;
// A player of many controls, its play button in the middle.
const PLAYER_PAGE =
  `<!doctype html><body style="margin:0;width:400px;height:240px;position:relative;background:#000">` +
  Array.from(
    { length: 30 },
    (_, n) =>
      `<button style="position:absolute;left:${(n % 10) * 40}px;top:${n < 10 ? 0 : 200}px;width:38px;height:38px">C${n}</button>`,
  ).join('') +
  `<button onclick="parent.postMessage('PLAYED', '*')" style="position:absolute;left:150px;top:90px;width:100px;height:60px">Play video</button></body>`;
// A page of forty thousand elements: every read waits its turn.
const BIG = 'https://shop.example/big';
const BIG_PAGE =
  `<!doctype html><title>Big</title><body><button id="more" onclick="document.title='MORE'">Show more</button><ul>` +
  Array.from(
    { length: 8_000 },
    (_, n) =>
      `<li><a href="/p/${n}">Product ${n}</a> <span>$${n}.99</span> <button type="button">Add</button></li>`,
  ).join('') +
  '</ul></body>';

// What a box says wherever a click lands in it, what a field turns into once
// focused, and the words checkouts commit in.
const BOXES = 'https://shop.example/boxes';
const BOXES_PAGE = `<!doctype html><title>Boxes</title>
<script>
customElements.define('pay-badge', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'closed' }).innerHTML = '<span>Pay $49.00</span>'; } });
</script><body>
<div id="decoy" onclick="document.title='PAID'" style="position:relative;width:340px;height:120px">
  <div style="position:absolute;inset:0">Details</div>
  <pay-badge style="position:absolute;left:8px;bottom:8px"></pay-badge></div>
<div id="framed" onclick="document.title='PAID'" style="position:relative;width:340px;height:120px">
  <div style="position:absolute;inset:0">Details</div>
  <iframe src="https://psp.example/badge" style="position:absolute;left:8px;bottom:8px;width:160px;height:30px;border:0"></iframe></div>
<div id="plain" onclick="document.title='PAID'" style="width:340px;height:60px"><span>Details</span> <div id="host"></div></div>
<script>document.getElementById('host').attachShadow({ mode: 'closed' }).innerHTML = '<b>Pay $49.00</b>';</script>
<button id="menu" onclick="document.title='MENU'" style="width:180px;height:48px">Open menu</button>
<div style="position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;font-size:40px;color:#ddd">Buy now</div>
<p><input id="search" type="text" name="search" aria-label="Search">
<script>document.getElementById('search').addEventListener('focus', (event) => {
  event.target.type = 'password'; event.target.name = 'cardnumber'; event.target.setAttribute('autocomplete', 'cc-number'); });</script></p>
<form onsubmit="document.title='ORDERED'; return false;"><input id="coupon" name="coupon" placeholder="Coupon code"><button>Place your order</button></form>
<p><a id="history" href="#" onclick="document.title='HISTORY'; return false;">Purchase history</a></p>
<fieldset><legend>Card details</legend><label for="exp">Expiry date</label> <input id="exp" name="exp2"></fieldset>
<p><label for="couponexp">Coupon expiry date</label> <input id="couponexp" name="couponexp"></p>
</body>`;
const BADGE_PAGE = '<!doctype html><body style="margin:0">Pay with card</body>';
// What is drawn but kept from the read-out, what is not drawn at all, and the
// words one-time codes and tips go by.
const DRAWN_ONLY = 'https://shop.example/drawnonly';
const DRAWN_ONLY_PAGE = `<!doctype html><title>Drawn only</title><body>
<div id="hiddenpay" onclick="document.title='PAID'" style="width:320px;height:120px"></div>
<script>document.getElementById('hiddenpay').attachShadow({ mode: 'open' }).innerHTML =
  '<div>Details</div><div aria-hidden="true" style="font-size:24px">Pay now $49.00</div>';</script>
<p><label>Verification code <input id="otp"></label></p>
<p><button id="tip" onclick="document.title='TIPPED'">Send tip</button></p>
</body>`;
// Menu items whose hidden lists hold "Buy gift cards" -- one not laid out, one
// laid out but not drawn -- on a page of their own: an element that is no
// control is read with the words around it, and on a page this short that is
// the whole page.
const MENU = 'https://shop.example/menu';
const MENU_PAGE = `<!doctype html><title>Menu</title><body><ul>
<li id="shopnav" onclick="document.title='MENU'"><span>Shop</span><ul style="display:none"><li><a href="/gift-cards/buy">Buy gift cards</a></li></ul></li>
<li id="giftnav" onclick="document.title='GIFTS'"><span>Gifts</span><ul style="visibility:hidden;position:absolute"><li><a href="/gift-cards/buy">Buy gift cards</a></li></ul></li>
</ul></body>`;
// A field in a component's shadow tree that submits the form around its host,
// the way design systems do; a card whose "Buy now" CSS draws, hidden from
// the read-out; a human check by the words it uses; a header whose menu
// button says nothing beside a drawer of 49 hidden links; and a pay widget
// from another site in a feed of 2,100 cards.
const ROUND11 = 'https://shop.example/round11';
const ROUND11_PAGE = `<!doctype html><title>Round 11</title>
<style>.cta::after { content: "Buy now"; }</style>
<script>
customElements.define('x-input', class extends HTMLElement { constructor() { super();
  const root = this.attachShadow({ mode: 'open', delegatesFocus: true });
  root.innerHTML = '<input aria-label="Email">';
  root.querySelector('input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') { return; }
    const button = document.createElement('button');
    button.type = 'submit';
    button.hidden = true;
    this.closest('form').append(button);
    button.click();
    button.remove();
  }); } });
addEventListener('message', (event) => { document.title = String(event.data); });
</script><body>
<header><a href="/">ShopCo</a> <button id="burger" onclick="document.title='OPENED'"><svg width="24" height="24"><path d="M3 6h18M3 12h18M3 18h18" stroke="#000"></path></svg></button>
<nav style="display:none"><ul>${Array.from({ length: 48 }, (_, n) => `<li><a href="/d/${n}">Department ${n}</a></li>`).join('')}<li><a href="/sell">Sell on ShopCo</a></li></ul></nav></header>
<main><p>${'Spring collection and ordinary words about it. '.repeat(4)}</p>
<form id="checkout" onsubmit="event.preventDefault(); document.title='PAID';"><x-input id="email"></x-input><button type="submit">Pay $49.00</button></form>
<div id="plan" onclick="document.title='PAID'" style="width:300px"><h3>Pro plan</h3><p>$9.99 per month.</p><span class="cta" aria-hidden="true"></span></div>
<p><label><input type="checkbox" id="human" onclick="document.title='VERIFIED'"> Verify you are human</label></p>
</main></body>`;
// The dates of a stay and a sum to transfer, which a click only focuses; a
// field in a pay button; and a long form whose field and pay button are both
// components: Enter in the field submits the form, and the button's words sit
// far from either end of all it says.
const ROUND12 = 'https://shop.example/round12';
const ROUND12_PAGE = `<!doctype html><title>Round 12</title>
<script>
customElements.define('x-field', class extends HTMLElement { constructor() { super();
  const root = this.attachShadow({ mode: 'open', delegatesFocus: true });
  root.innerHTML = '<input aria-label="Promo code">';
  root.querySelector('input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { this.closest('form').requestSubmit(); }
  }); } });
customElements.define('x-pay', class extends HTMLElement { constructor() { super();
  const root = this.attachShadow({ mode: 'open' });
  root.innerHTML = '<button part="base"><slot></slot></button>';
  root.querySelector('button').addEventListener('click', () => this.closest('form').requestSubmit()); } });
</script><body>
<h1>Book your stay</h1>
<p><label for="checkin-date">Check in</label> <input type="date" id="checkin-date"> <label for="checkout-date">Check out</label> <input type="date" id="checkout-date" onclick="document.title='PICKER'"></p>
<p><label for="amount">Amount to transfer</label> <input id="amount" inputmode="decimal" onclick="document.title='AMOUNT'"></p>
<p><button id="buy" onclick="document.title='PAID'">Buy now <input id="quantity" value="1" size="2"></button></p>
<form id="upgrade" onsubmit="event.preventDefault(); document.title='PAID';"><h2>Payment details</h2>
<p>${'You are upgrading to Pro, with unlimited projects and priority support for your whole team. '.repeat(4)}</p>
<x-field id="promo"></x-field> <x-pay>Pay $49.00</x-pay>
<p>${'Plans renew at the end of each period until cancelled, and receipts go to your email. '.repeat(5)}</p></form>
<form id="filters" onsubmit="event.preventDefault(); document.title='FILTERED';"><x-field id="filter-q"></x-field>
${Array.from({ length: 120 }, (_, n) => `<button type="button">Tag ${n}</button>`).join('')}</form>
<form id="huge" onsubmit="event.preventDefault(); document.title='SUBMITTED';"><x-field id="huge-q"></x-field>
${Array.from({ length: 300 }, (_, n) => `<button type="button">Filter ${n}: a long name for one of the many filters here</button>`).join('')}</form>
</body>`;
// A label of a date, a search box of labelled dates that opens on a click, a
// quantity in a row that buys on a click, a long donation form whose pay
// control is a link a script submits it with, and two confirms: one that pays
// after saying what it will not charge, one that cancels a priced plan.
const ROUND13 = 'https://shop.example/round13';
const ROUND13_PAGE = `<!doctype html><title>Round 13</title><body>
<h1>Book your stay</h1>
<p><label id="co-label" for="co">Check out</label> <input type="date" id="co" onclick="document.title='PICKER'"></p>
<div id="search" onclick="document.title='SEARCH_OPEN'"><label for="ci2">Check in</label> <input id="ci2" readonly value="Oct 12">
<label for="co2">Check out</label> <input id="co2" readonly value="Oct 14"> <button type="button">2 guests</button></div>
<div id="row" onclick="document.title='PAID'"><span>Buy now $49.00</span> <input id="qty" type="number" value="1" aria-label="Quantity"></div>
<form id="give" onsubmit="event.preventDefault(); document.title='PAID';"><h2>Support our work</h2>
<p>${'Every gift keeps the archive open to readers everywhere, free of charge and free of ads. '.repeat(4)}</p>
<label>Email for your receipt <input id="receipt" type="email"></label>
<p><a href="#" onclick="this.closest('form').requestSubmit(); return false;">Donate $25 now</a></p>
<p>${'Gifts are tax-deductible where the law allows, and you can change or stop them at any time. '.repeat(6)}</p></form>
<p><button id="go-on" onclick="if (confirm(&quot;You won't be charged any extra fees when you pay $49.00 now with your saved card. Continue?&quot;)) { document.title = 'PAID'; }">Continue</button>
<button id="cancel-plan" onclick="if (confirm('Are you sure you want to cancel your Premium plan ($9.99/month)?')) { document.title = 'CANCELLED'; }">Cancel plan</button></p>
</body>`;
// A human check that names itself only by its heading, and a dialog that sets
// one up.
const ROUND13_DIALOGS = 'https://shop.example/round13-dialogs';
const ROUND13_DIALOGS_PAGE = `<!doctype html><title>Round 13 dialogs</title><body>
<div role="dialog"><h2>Let's confirm you are human</h2><p>To keep this site safe, complete a quick check.</p>
<button id="begin" onclick="document.title='STARTED'">Begin</button></div>
<div role="dialog" aria-label="reCAPTCHA settings"><p>Keys for the sign-up form.</p><input aria-label="Site key">
<button id="cancel-settings" onclick="document.title='CANCELLED'">Cancel</button></div>
</body>`;
// A search box with no form above a list of five thousand items.
const CROWDED_SEARCH = 'https://shop.example/crowded-search';
const CROWDED_SEARCH_PAGE =
  `<!doctype html><title>Crowded search</title><body><header><input id="cq" placeholder="Search the feed" ` +
  `onkeydown="if (event.key === 'Enter') { document.title = 'SEARCHED'; }"> <button>Search</button></header><ul>` +
  Array.from({ length: 2_500 }, (_, n) => `<li><span>Item ${n}</span></li>`).join('') +
  '</ul></body>';
const FEED = 'https://shop.example/feed';
const FEED_PAGE =
  `<!doctype html><title>Feed</title><script>addEventListener('message', (event) => { document.title = String(event.data); });</script>` +
  `<body><div id="feed"><article><h3>Gift card</h3><iframe id="widget" title="Support the author" src="https://psp.example/widget" style="width:320px;height:90px;border:0"></iframe></article>` +
  Array.from({ length: 2_100 }, (_, n) => `<article><h3>Product ${n}</h3></article>`).join('') +
  '</div></body>';
// A button beside thirty thousand siblings: the browser takes seconds over its
// accessibility tree there.
const CROWD = 'https://shop.example/crowd';
const CROWD_PAGE =
  `<!doctype html><title>Crowd</title><body><button id="open" onclick="document.title='OPENED'">Open the settings page</button>` +
  Array.from({ length: 30_000 }, (_, n) => `<span>x${n}</span>`).join('') +
  '</body>';

// A page that answers the drive's own calls in its world with a promise that
// never settles.
const STALL = 'https://shop.example/stall';
const STALL_PAGE = `<!doctype html><title>Stall</title><body>
<script>
var slice = String.prototype.slice;
String.prototype.slice = function (a, b) { return a === 0 && b === 600 ? { then: function () {} } : slice.call(this, a, b); };
</script>
<form onsubmit="document.title='SEARCHED'; return false;"><input id="sq" aria-label="Search"><button>Search</button></form>
</body>`;

// A label that pays on a click of its own, one that holds a Donate button, a
// Details button in a box that buys on a click, a box around the whole basket
// that counts clicks, a donation form drawn inside a box that counts clicks,
// a card form set out in sections, a gift card's form, a traveller's expiry in
// a section of its own, and a component that buys on a click around the
// quantity field it draws.
const ROUND14 = 'https://shop.example/round14';
const ROUND14_PAGE = `<!doctype html><title>Round 14</title><body>
<div id="app" onclick="void 0"><h1>Your basket</h1>
<p><label id="pay-label" for="holder" onclick="document.title='PAID'">Pay $49.00</label> <input id="holder" aria-label="Name on the receipt"></p>
<p><label id="donate-label" for="note">Note <button type="button" onclick="document.title='DONATED'">Donate $25</button></label> <input id="note"></p>
<div id="buy-box" onclick="document.title='PAID'"><span>Buy now $49.00</span> <button id="details" type="button">Details</button></div>
<p>${'Prices include VAT. Delivery takes three to five working days. '.repeat(3)}</p>
<button id="more14" type="button" onclick="document.title='MORE'">Show more</button></div>
<form id="give14" onsubmit="event.preventDefault(); document.title='PAID';"><div onclick="void 0">
<p>${'Every gift keeps the archive open to readers everywhere. '.repeat(4)}</p>
<label>Email for your receipt <input id="receipt14" type="email"></label>
<p><a href="#" onclick="this.closest('form').requestSubmit(); return false;">Donate $25 now</a></p>
<p>${'Gifts are tax-deductible where the law allows. '.repeat(6)}</p></div></form>
<form id="card14" onsubmit="event.preventDefault(); document.title='PAID';">
<section><label>Card number <input name="cardnumber"></label></section>
<section><label>Expiry date <input id="exp14" name="expiry" oninput="document.title='TYPED'"></label></section>
<button>Pay $49.00</button></form>
<form id="gift14" onsubmit="event.preventDefault(); document.title='PAID';"><fieldset><legend>Buy a gift card</legend>
<label>Card number <input name="cardnumber"></label> <label>Expiration date <input id="gift-exp" oninput="document.title='TYPED'"></label></fieldset></form>
<section><h2>Traveller 1</h2><label>Date of expiry <input id="doe14" name="doe" oninput="document.title='TYPED'"></label></section>
<buy-qty id="qty-host" onclick="document.title='PAID'"></buy-qty>
<script>customElements.define('buy-qty', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = '<span>Buy now $49.00</span> <label for="q">Qty</label> <input id="q" type="number" value="1">'; } });</script>
</body>`;
// A page that asks something a moment after it loads, and is navigated away
// from before anyone answers.
// A row that draws "Buy now $49.00" and keeps a style sheet in its markup, a
// card component whose price another component draws, a product tile of a
// component with its own buttons, a wordmark, and a checkout form with a
// passenger's fieldset beside the card's.
const ROUND15 = 'https://shop.example/round15';
const ROUND15_PAGE = `<!doctype html><title>Round 15</title><body>
<p>${'Our store ships worldwide. Browse the catalogue and read the reviews first. '.repeat(2)}</p>
<div id="row15" onclick="document.title='PAID'"><style>.r15{display:inline-flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px}</style>
<span>Buy now $49.00</span> <input id="qty15" value="1" size="3" aria-label="Quantity"></div>
<buy-card15 id="card15" onclick="document.title='PAID'"></buy-card15>
<ul><li><product-tile15 id="tile15"></product-tile15></li></ul>
<button id="paypal15" onclick="document.title='LOGIN'">Log in with <span style="color:#003087">Pay</span><span style="color:#009cde">Pal</span></button>
<form id="trip15" onsubmit="event.preventDefault(); document.title='PAID';">
<fieldset><legend>Passenger 1</legend><label>Passport number <input name="pax1_passport"></label>
<label>Expiry date <input id="pax-exp15" name="pax1_expiry" oninput="document.title='TYPED'"></label>
<label>Nationality <input name="pax1_nationality"></label></fieldset>
<fieldset><legend>Payment</legend><label>Card number <input name="cardnumber"></label>
<label>Expiry date <input id="card-exp15" name="cc_expiry" oninput="document.title='TYPED'"></label></fieldset></form>
<script>
customElements.define('price-tag15', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = '<b>Buy now $49.00</b>'; } });
customElements.define('buy-card15', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = '<price-tag15></price-tag15> <input id="cq15" value="1" size="3" aria-label="Quantity">'; } });
customElements.define('product-tile15', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = '<div><b>Wireless Headphones</b> <span>$49.00</span> <button id="wish15" onclick="document.title=&quot;SAVED&quot;">Add to wishlist</button> <button id="buy15">Buy now</button></div>'; } });
</script>
</body>`;
// A page that shows an alert a moment after it loads, and a page whose inline
// script asks to pay before its content has loaded.
const ROUND15_ALERT = 'https://shop.example/round15-alert';
const ROUND15_ALERT_PAGE = `<!doctype html><title>Cart</title><body><h1>Your cart</h1>
<script>setTimeout(() => alert('Your cart was updated'), 300);</script></body>`;
const ROUND15_PAY = 'https://shop.example/round15-pay';
const ROUND15_PAY_PAGE = `<!doctype html><title>Checkout</title><script>document.title = confirm('Pay $49.00 now?') ? 'PAID' : 'NOTPAID';</script><body><h1>Checkout</h1></body>`;
// A row that buys on a click, its words beside a description for screen
// readers; a card that opens its page, all of its text shown; a confirm that
// names its own Cancel button; a pay button with its amount inside; a card
// form that keeps the expiry beside the security code.
const ROUND16 = 'https://shop.example/round16';
const ROUND16_PAGE = `<!doctype html><title>Round 16</title><body>
<h1>Acme Wireless Headphones</h1><p>Noise cancelling over-ear headphones with 30 hours of battery life, a carrying case and a two-year warranty.</p>
<div onclick="document.title='PAID'" style="padding:12px;border:1px solid #ccc;width:360px;position:relative"><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Buy Acme Wireless Headphones in black for 49 dollars, ships tomorrow, free returns</span><b aria-hidden="true">Buy now $49.00</b> <input id="qty16" type="number" value="1" aria-label="Quantity" style="width:50px"></div>
<div onclick="document.title='OPENED'" style="padding:12px;width:360px"><b>Wireless Headphones Pro</b> <span>Free returns within 30 days. Ships in 2 business days. Price includes VAT and duties.</span> <input id="note16" aria-label="Gift note"></div>
<button id="total16" onclick="document.title = confirm('Total: $49.00. Press OK to continue or Cancel to go back.') ? 'PAID' : 'NOTPAID'">Continue</button>
<button id="submit16" onclick="document.title='PAID'">Submit $49.00 payment</button>
<form onsubmit="return false"><label>Card number <input name="cardnumber" autocomplete="cc-number"></label>
<div role="group"><label>Expiration date <input id="exp16" name="expiry" placeholder="MM / YYYY" oninput="document.title='TYPED'"></label>
<label>Security code <input name="security_code"></label></div></form>
</body>`;
// A help page whose chat widget, from another site, says hello in a dialog --
// and then the page takes the widget away. And a component that buys around
// the slot of its closed tree, and a row of floats with a description for
// screen readers.
const ROUND17_FRAME = 'https://shop.example/round17-frame';
const ROUND17_FRAME_PAGE = `<!doctype html><title>Help</title><body><h1>Help centre</h1>
<p>Find answers to common questions, or chat with us.</p>
<iframe id="chat17" src="https://chat.example/widget" style="width:300px;height:80px;border:0"></iframe>
<script>setTimeout(() => { const chat = document.getElementById('chat17'); if (chat) chat.remove(); }, 1500);</script>
</body>`;
const ROUND17 = 'https://shop.example/round17';
const ROUND17_PAGE = `<!doctype html><title>Round 17</title><body>
<h1>Acme Wireless Headphones</h1><p>Noise cancelling over-ear headphones with 30 hours of battery life, a carrying case and a two-year warranty.</p>
<script>customElements.define('buy-box17', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'closed' }).innerHTML = '<div onclick="document.title=&quot;PAID&quot;" style="padding:12px;width:360px"><b>Buy now $49.00</b> <slot></slot></div>'; } });</script>
<buy-box17><button id="det17" type="button">Details</button></buy-box17>
<div onclick="document.title='PAID'" style="width:360px;position:relative"><b style="float:left">Buy now $49.00</b><button id="det17b" type="button" style="float:left">Details</button><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Wireless headphones in black, ships tomorrow, free returns within thirty days of delivery</span></div>
<p style="clear:both">Reviews and questions are further down the page.</p>
</body>`;
// A help page with a widget from another site whose hello comes up in place of
// the page's own notice; and a page whose comment box, in a frame of another
// site, asks to stay when the page is left.
const ROUND18_FRAME = 'https://shop.example/round18-frame';
const ROUND18_FRAME_PAGE = `<!doctype html><title>Help</title><body><h1>Help centre</h1>
<p>Find answers to common questions, or chat with us.</p>
<iframe id="chat18" src="https://chat.example/round18" style="width:300px;height:80px;border:0"></iframe>
<script>window.showNotice = () => setTimeout(() => alert('Your session will expire soon'), 200);</script></body>`;
const ROUND18_STAY = 'https://shop.example/round18-stay';
const ROUND18_STAY_PAGE = `<!doctype html><title>Article</title><body><h1>How to choose headphones</h1>
<p>Comfort, battery life and noise cancelling matter most. Leave a comment below.</p>
<iframe id="comments18" src="https://comments.example/box" style="width:400px;height:80px;border:0"></iframe></body>`;
const COMMENTS_PAGE = `<!doctype html><body><input id="comment" placeholder="Your comment">
<script>addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = ''; });</script></body>`;
// A page set to the window's height whose wrapper of floats takes clicks, a
// "Checkout" link in its first screen and the reviews further down.
const ROUND18_TALL = 'https://shop.example/round18-tall';
const ROUND18_TALL_PAGE = `<!doctype html><title>Reviews</title><style>html, body { height: 100%; margin: 0 }
body { font: 16px/1.4 Arial, sans-serif } .hero { height: 100vh; background: #eee }</style><body>
<div id="page18" onclick="window.menusClosed = true" style="width:100%">
<header style="float:left;width:100%"><a href="#checkout">Checkout</a></header>
<div class="hero" style="float:left;width:100%"></div>
<section style="float:left;width:100%"><h2>Reviews</h2>
<p>Great sound and a comfortable fit for long flights. The case is sturdy and the battery lasts all week.</p>
<button id="more18" type="button" onclick="document.title='MORE'">Load more reviews</button></section></div></body>`;
// A help page with a <details>, components in components around a pay box,
// highlights a search left, a card that clips a box that buys, and a save
// button that tells it saved.
const ROUND18 = 'https://shop.example/round18';
const ROUND18_PAGE = `<!doctype html><title>Round 18</title><style>body { font: 16px/1.4 Arial, sans-serif }
.chip { display: inline-block; padding: 4px 10px; border: 1px solid #ccc; border-radius: 12px; cursor: pointer }</style><body>
<h1>Help and deals</h1><p>Answers to the questions we hear most often about orders, delivery and returns, and today's offers on audio gear.</p>
<details open><summary id="sum18">How long does delivery take?</summary><p>Two to four working days. <a id="lnk18" href="#returns">How returns work</a></p></details>
<script>customElements.define('buy-box18', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'closed' }).innerHTML = '<div onclick="document.title=&quot;PAID&quot;" style="padding:12px;width:360px"><b>Buy now $49.00</b> <slot></slot></div>'; } });
customElements.define('fancy-row18', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = '<div class="row"><slot></slot></div>'; } });
customElements.define('ds-input18', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = '<input placeholder="Quantity">'; } });</script>
<buy-box18><fancy-row18><button id="det18" type="button">Details</button></fancy-row18></buy-box18>
<buy-box18><ds-input18 id="qty18"></ds-input18></buy-box18>
<p>Topics: <span id="chip18" class="chip" onclick="document.title='FILTERED'">My <mark>pay</mark>ments</span></p>
<a id="card18" href="#r1" style="display:block;width:420px;padding:8px;color:inherit;text-decoration:none"><h3 style="margin:0;font-size:16px"><mark>Pay</mark>ment methods we accept</h3>
<p style="margin:4px 0;font-size:14px">Which cards we take, and when your statement shows the amount.</p></a>
<div style="width:320px;height:24px;overflow:hidden;line-height:24px"><div onclick="document.title='PAID'"><b>Buy now $49.00</b>
<button id="det18c" type="button" style="height:20px;line-height:16px;padding:0 6px">Details</button>
<p style="margin:0">Noise cancelling over-ear headphones with 30 hours of battery life, a carrying case and a two-year warranty.</p></div></div>
<button id="save18" type="button" onclick="alert('Your changes were saved')">Save changes</button>
</body>`;
// A carousel of long product cards, one scrolled past its edge; a closed pay
// box deep in a page; a short pay box whose words two inline boxes set apart;
// and a check-out date deep in a page.
const ROUND19 = 'https://shop.example/round19';
const ROUND19_CARD = (n: number) =>
  `<article onclick="location.hash='p${n}'" style="flex:0 0 300px;padding:12px;border:1px solid #ddd">` +
  `<h3>Trail shoe ${n}</h3><p>Lightweight trail shoes with a grippy sole, a breathable mesh upper, a padded collar and a cushioned midsole for long days out.</p>` +
  `<p><button id="cart19-${n}" type="button">Add to cart</button> <a href="#buy${n}">Buy now</a></p></article>`;
const ROUND19_DEEP = (inner: string, depth: number) =>
  `${'<div>'.repeat(depth)}${inner}${'</div>'.repeat(depth)}`;
const ROUND19_PAGE = `<!doctype html><title>Round 19</title><style>body { font: 16px/1.4 Arial, sans-serif }</style><body>
<h1>Trail shoes</h1><p>Our most popular trail shoes this season, picked by runners who test them every week on rough ground.</p>
<div style="display:flex;gap:12px;overflow-x:auto;width:960px">${[1, 2, 3, 4, 5, 6].map(ROUND19_CARD).join('')}</div>
<script>customElements.define('buy-row19', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'closed' }).innerHTML = '<div onclick="document.title=&quot;PAID&quot;">Buy now $49.00 <slot></slot></div>'; } });</script>
${ROUND19_DEEP('<buy-row19><button id="det19" type="button">Details</button></buy-row19>', 62)}
<div onclick="document.title='PAID'" style="padding:8px;width:320px"><span style="display:inline-block">Buy</span><span style="display:inline-block;margin-left:8px">49,00 €</span> <button id="det19b" type="button">Details</button></div>
${ROUND19_DEEP('<label>Check out <input id="co19" type="date"></label>', 64)}
</body>`;
const ROUND20 = 'https://shop.example/round20';
// A buy row of no size of its own in a panel that scrolls, with a note set
// where no scrolling reaches; a menu item whose submenu waits in a hidden
// panel of its component; a highlighted search result cut off by an
// ellipsis; a padded highlight beside a Share button in a row that opens; a
// two-colour wordmark of two inline blocks; a Korean confirm that pays (the
// page says how it is encoded: served without a charset, its Korean would be
// read as another encoding's letters).
const ROUND20_PAGE = `<!doctype html><meta charset="utf-8"><title>Round 20</title><style>body { font: 16px/1.4 Arial, sans-serif }</style><body>
<h1>Help and shop</h1><p>Find answers about your account, payments and orders, or buy the tools our customers love most this season.</p>
<div style="height:200px;overflow:auto"><div onclick="document.title='PAID'" style="cursor:pointer;width:420px">
<div style="float:left;padding:8px"><b id="name20">Steel trowel</b></div><div style="float:left;padding:8px">Buy now $49.00</div>
<span style="position:absolute;left:-9999px">Hand-forged in Sheffield from carbon steel with an ash handle. Lifetime guarantee against breakage.</span>
</div><div style="clear:both;height:300px"></div></div>
<nav aria-label="Main"><menu-item20><a id="shop20" href="#shop">Shop</a><div slot="submenu"><a href="#gift">Buy gift cards</a></div></menu-item20></nav>
<script>customElements.define('menu-item20', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = '<div role="menuitem"><slot></slot><div hidden><slot name="submenu"></slot></div></div>'; } });</script>
<div id="result20" onclick="document.title='METHODS'" style="cursor:pointer;width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><em>Pay</em>ment methods and billing address settings for your account</div>
<div onclick="document.title='ROW'" style="cursor:pointer"><span><mark style="padding:.2em;background:#fcf8e3">Pay</mark>ment methods</span> <button id="share20" type="button" onclick="event.stopPropagation(); document.title='SHARED'">Share</button></div>
<button id="paypal20" type="button" onclick="document.title='LOGIN'">Log in with <span style="display:inline-block;color:#003087">Pay</span><span style="display:inline-block;color:#009cde">Pal</span></button>
<button id="next20" type="button" onclick="document.title = confirm('확인 버튼을 누르면 49,000원이 결제되며 취소 버튼을 누르면 결제가 취소됩니다.') ? 'PAID' : 'NOTPAID'">다음</button>
</body>`;
const ROUND21 = 'https://shop.example/round21';
// A buy row in a clearfix wrapper (overflow: auto, nothing to scroll) in a
// list item of a set height; one slotted into a closed card of a set height;
// "Buy" beside a padded price chip; a design-system button in a pay box whose
// words CSS sets apart; a pay box with a section hidden until found; a
// zoomed carousel whose last card adds to the cart; a confirm whose told stop
// is followed by the amount due.
const ROUND21_PAGE = `<!doctype html><meta charset="utf-8"><title>Round 21</title><style>body { font: 16px/1.4 Arial, sans-serif }</style><body>
<h1>Deals of the week</h1><p>Hand-picked tools and clothes at their lowest price this month, while stocks last in our warehouse.</p>
<ul style="list-style:none;padding:0;width:420px"><li style="height:44px;overflow:hidden;border-bottom:1px solid #ddd"><div style="overflow:auto">
<div onclick="document.title='PAID'" style="cursor:pointer"><b>Buy now $49.00</b> <button id="clear21" type="button">Details</button>
<p style="margin:6px 0 0">Ships in 2 days. Free returns within 30 days. Includes charger, cable, case and a two-year warranty from the maker.</p></div></div></li></ul>
<script>customElements.define('card-21', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'closed' }).innerHTML = '<div style="width:360px;height:30px;overflow:hidden;border:1px solid #ccc"><slot></slot></div>'; } });
customElements.define('ds-button21', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = '<button type="button" style="font:inherit"><slot></slot></button>'; } });</script>
<card-21><div onclick="document.title='PAID'"><b>Buy now $49.00</b> <button id="closed21" type="button">Details</button>
<p>Ships in 2 days. Free returns within 30 days. Includes charger, cable, case and a two-year warranty from the maker.</p></div></card-21>
<button id="chip21" type="button" onclick="document.title='PAID'">Buy<span style="background:#e8f0fe;border-radius:4px;padding:2px 4px">49,00 €</span></button>
<div onclick="document.title='PAID'" style="padding:8px;border:1px solid #888"><span style="display:inline-block;font-weight:bold">Buy</span><span style="display:inline-block;margin-left:8px">49,00 €</span> <ds-button21 id="ds21">More</ds-button21></div>
<div onclick="document.title='PAID'" style="padding:8px;border:1px solid #888"><b>Buy now $49.00</b><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">Opens the secure payment step for this item, total includes VAT.</span> <div hidden="until-found">Free returns within thirty days. Ships from our warehouse in two to four business days.</div> <button id="found21" type="button">Details</button></div>
<div style="zoom:1.5"><div style="display:flex;gap:8px;overflow-x:auto;width:400px">${[
  1, 2, 3, 4, 5,
]
  .map(
    (n) =>
      `<article onclick="location.hash='p${n}'" style="flex:0 0 280px;padding:8px;border:1px solid #ddd"><h3>Trail shoe ${n}</h3><p>Lightweight trail shoes with a grippy sole, a breathable mesh upper, a padded collar and a cushioned midsole.</p><p><button id="add21-${n}" type="button" onclick="event.preventDefault(); document.title='ADDED${n}'">Add to cart</button> <a href="#buy${n}">Buy now</a></p></article>`,
  )
  .join('')}</div></div>
<button id="end21" type="button" onclick="document.title = confirm('Your monthly charges will end today. Total due today: $99.00. Continue?') ? 'PAID' : 'NOTPAID'">Continue</button>
</body>`;
const ROUND22 = 'https://shop.example/round22';
// "Buy" beside a padded price chip that begins with letters; a sheet fixed to
// the bottom of a long page that peeks up, its description below the window;
// a Korean confirm whose OK places the order; one that stops a plan but asks
// for an early-termination fee.
const ROUND22_PAGE = `<!doctype html><meta charset="utf-8"><title>Round 22</title><style>body { font: 16px/1.4 Arial, sans-serif }</style><body>
<h1>Deals of the week</h1><p>Hand-picked tools and clothes at their lowest price this month, while stocks last in our warehouse.</p>
<button id="chf22" type="button" onclick="document.title='PAID'">Buy<span style="background:#e8f0fe;border-radius:4px;padding:2px 4px">CHF 49.00</span></button>
<button id="ko22" type="button" onclick="document.title = confirm('확인을 누르면 주문이 완료되어 취소할 수 없습니다. 계속하시겠습니까?') ? 'PAID' : 'NOTPAID'">다음</button>
<button id="fee22" type="button" onclick="document.title = confirm('Cancel your plan? You will no longer pay $9.99/month, but $49.00 is due today to end your contract early.') ? 'PAID' : 'NOTPAID'">Continue</button>
<div style="height:2400px"></div>
<div onclick="document.title='PAID'" style="position:fixed;left:0;right:0;bottom:0;height:260px;transform:translateY(204px);background:#fff;border-top:1px solid #ccc">
<div style="height:40px;padding:8px"><b>Buy now $49.00</b> <button id="sheet22" type="button">Details</button></div>
<p style="margin:0;padding:8px">Ships in 2 days. Free returns within 30 days. Includes charger, cable, case and a two-year warranty from the maker.</p></div>
</body>`;
const ROUND23 = 'https://shop.example/round23';
// A card component whose closed tree clips the buy row slotted into it, defined
// only once the page calls defineCard; a confirm that stops a contract's
// charges but keeps its fee, or waives it only on a condition; a Korean total
// that says a discount was applied, and a return that only says its refund; a
// button that orders again.
const ROUND23_PAGE = `<!doctype html><meta charset="utf-8"><title>Round 23</title><style>body { font: 16px/1.4 Arial, sans-serif }</style><body>
<h1>Blue T-shirt</h1><p>Soft cotton tee in five colours. Machine washable. Ships in two days.</p>
<script>window.defineCard = () => customElements.define('card-c', class extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: 'closed' }); r.innerHTML = '<div style="height:34px;overflow:hidden;border:1px solid #888"><slot></slot></div>'; } });</script>
<button id="waive23" type="button" onclick="document.title = confirm('Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 will not be waived.') ? 'PAID' : 'NOTPAID'">Cancel contract</button>
<button id="apply23" type="button" onclick="document.title = confirm('Cancel your contract? Your monthly charges will stop, and the $199.00 early termination fee will not apply if you return your device within 30 days.') ? 'PAID' : 'NOTPAID'">End contract</button>
<button id="ko23" type="button" onclick="document.title = confirm('총 49,000원(할인 적용)입니다. 계속하시겠습니까?') ? 'PAID' : 'NOTPAID'">다음</button>
<button id="refund23" type="button" onclick="document.title = confirm('반품을 신청하시겠습니까? 총 49,000원이 환불될 예정입니다.') ? 'RETURNED' : 'NOTRETURNED'">반품 신청</button>
<button id="repeat23" type="button" onclick="document.title='PAID'">Repeat last order for $23.50</button>
<card-c><div onclick="document.title='PAID'" style="padding:4px"><b>Buy now $49.00</b> <button id="late23" type="button">Details</button><p style="margin:4px 0 0">Free returns within thirty days of delivery; this item ships from and is sold by the store. Gift wrap available at checkout.</p></div></card-c>
</body>`;
const ROUND14_ALERT = 'https://shop.example/round14-alert';
const ROUND14_ALERT_PAGE = `<!doctype html><title>Expired</title><body><h1>Welcome back</h1>
<script>addEventListener('load', () => setTimeout(() => alert('Your session has expired'), 200));</script></body>`;
// One form around a whole page of a thousand rows, each with its own submit
// button, and a search box at its top.
const GRID = 'https://shop.example/grid';
const GRID_PAGE =
  `<!doctype html><title>Grid</title><body><form id="aspnetForm" onsubmit="document.title='SUBMITTED'; return false;">` +
  `<input type="hidden" name="__VIEWSTATE" value="abc"><header><h1>Customers</h1>` +
  `<input id="gq" name="q" placeholder="Search customers"> <input type="submit" name="search" value="Search"></header><table><tbody>` +
  Array.from(
    { length: 1_000 },
    (_, n) =>
      `<tr><td><input type="checkbox" name="sel" value="${n}"></td><td>Customer ${n}</td><td>customer${n}@mail.example</td>` +
      `<td><input type="hidden" name="key_${n}" value="${n}"><input type="submit" name="edit_${n}" value="Edit"></td></tr>`,
  ).join('') +
  '</tbody></table></form></body>';
// A player from another site, after an ad from a third that keeps its page busy.
const WATCH = 'https://shop.example/watch';
const WATCH_PAGE =
  `<!doctype html><title>Watch</title><script>addEventListener('message', (event) => { document.title = String(event.data); });</script>` +
  `<body><h1>Watch</h1><iframe src="https://busyad.example/slot" style="width:120px;height:60px;border:0"></iframe>` +
  `<iframe id="watch-player" title="Video player" src="https://player.example/embed" style="width:400px;height:240px;border:0"></iframe></body>`;
const BUSY_AD_PAGE =
  `<!doctype html><body style="margin:0;font:10px sans-serif"><a href="#">Great deals</a><script>` +
  `function spin() { const start = Date.now(); while (Date.now() - start < 2500); setTimeout(spin, 30); }` +
  `addEventListener('load', () => setTimeout(spin, 0));</script></body>`;

const DENYLIST = addAoiBrowserDriveAllowlistEntry(
  { version: 1, entries: [], updatedAt: 0 },
  { domain: 'evil.example' },
  1,
).allowlist;

test.describe('browser drive looks at the page after an act', () => {
  test.describe.configure({ timeout: 90_000 });

  let profileDir = '';
  let session: AoiBrowserDriveSession | null = null;
  let slowRequests = 0;

  test.beforeEach(async () => {
    test.skip(!systemBrowser, 'no Chrome or Edge is installed on this machine');
    profileDir = fs.mkdtempSync(join(os.tmpdir(), 'aoi-drive-look-'));
    session = await startAoiBrowserDriveSession({
      engine: systemBrowser?.engine.startsWith('edge') ? 'edge' : 'chrome',
      userDataDir: profileDir,
      headless: true,
      browserExecutablePath: systemBrowser?.path,
      timeoutMs: 30_000,
    });
    slowRequests = 0;
    await (session.page as unknown as Page).route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith(WORDS)) {
        return route.fulfill({ contentType: 'text/html', body: WORDS_PAGE });
      }
      if (url.startsWith(AIMED)) {
        return route.fulfill({ contentType: 'text/html', body: AIMED_PAGE });
      }
      if (url.startsWith(BOXES)) {
        return route.fulfill({ contentType: 'text/html', body: BOXES_PAGE });
      }
      if (url.startsWith(DRAWN_ONLY)) {
        return route.fulfill({ contentType: 'text/html', body: DRAWN_ONLY_PAGE });
      }
      if (url.startsWith(MENU)) {
        return route.fulfill({ contentType: 'text/html', body: MENU_PAGE });
      }
      if (url.startsWith(ROUND11)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND11_PAGE });
      }
      if (url.startsWith(ROUND12)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND12_PAGE });
      }
      if (url.startsWith(ROUND13_DIALOGS)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND13_DIALOGS_PAGE });
      }
      if (url.startsWith(ROUND13)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND13_PAGE });
      }
      if (url.startsWith('https://chat.example/round18')) {
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><body><p>Chat</p><script>window.sayHello = () => setTimeout(() => alert('Hi! Need help?'), 1200);</script></body>`,
        });
      }
      if (url.startsWith('https://comments.example/')) {
        return route.fulfill({ contentType: 'text/html', body: COMMENTS_PAGE });
      }
      if (url.startsWith(ROUND18_FRAME)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND18_FRAME_PAGE });
      }
      if (url.startsWith(ROUND18_STAY)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND18_STAY_PAGE });
      }
      if (url.startsWith(ROUND18_TALL)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND18_TALL_PAGE });
      }
      if (url.startsWith(ROUND23)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND23_PAGE });
      }
      if (url.startsWith(ROUND22)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND22_PAGE });
      }
      if (url.startsWith(ROUND21)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND21_PAGE });
      }
      if (url.startsWith(ROUND20)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND20_PAGE });
      }
      if (url.startsWith(ROUND19)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND19_PAGE });
      }
      if (url.startsWith(ROUND18)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND18_PAGE });
      }
      if (url.startsWith('https://chat.example/')) {
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><body><p>Chat</p><script>setTimeout(() => alert('Hi! Need help?'), 300);</script></body>`,
        });
      }
      if (url.startsWith(ROUND17_FRAME)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND17_FRAME_PAGE });
      }
      if (url.startsWith(ROUND17)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND17_PAGE });
      }
      if (url.startsWith(ROUND16)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND16_PAGE });
      }
      if (url.startsWith(ROUND15_ALERT)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND15_ALERT_PAGE });
      }
      if (url.startsWith(ROUND15_PAY)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND15_PAY_PAGE });
      }
      if (url.startsWith(ROUND15)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND15_PAGE });
      }
      if (url.startsWith(ROUND14_ALERT)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND14_ALERT_PAGE });
      }
      if (url.startsWith(ROUND14)) {
        return route.fulfill({ contentType: 'text/html', body: ROUND14_PAGE });
      }
      if (url.startsWith(GRID)) {
        return route.fulfill({ contentType: 'text/html', body: GRID_PAGE });
      }
      if (url.startsWith(WATCH)) {
        return route.fulfill({ contentType: 'text/html', body: WATCH_PAGE });
      }
      if (url.startsWith('https://busyad.example/')) {
        return route.fulfill({ contentType: 'text/html', body: BUSY_AD_PAGE });
      }
      if (url.startsWith(CROWDED_SEARCH)) {
        return route.fulfill({ contentType: 'text/html', body: CROWDED_SEARCH_PAGE });
      }
      if (url.startsWith(FEED)) {
        return route.fulfill({ contentType: 'text/html', body: FEED_PAGE });
      }
      if (url.startsWith(CROWD)) {
        return route.fulfill({ contentType: 'text/html', body: CROWD_PAGE });
      }
      if (url.startsWith('https://psp.example/badge')) {
        return route.fulfill({ contentType: 'text/html', body: BADGE_PAGE });
      }
      if (url.startsWith(OWN_FRAME)) {
        return route.fulfill({ contentType: 'text/html', body: OWN_FRAME_PAGE });
      }
      if (url.startsWith(BIG)) {
        return route.fulfill({ contentType: 'text/html', body: BIG_PAGE });
      }
      if (url.startsWith('https://psp.example/')) {
        return route.fulfill({ contentType: 'text/html', body: PAY_FRAME_PAGE });
      }
      if (url.startsWith('https://player.example/')) {
        return route.fulfill({ contentType: 'text/html', body: PLAYER_PAGE });
      }
      if (url.startsWith(STALL)) {
        return route.fulfill({ contentType: 'text/html', body: STALL_PAGE });
      }
      if (url.startsWith(DRAWN)) {
        return route.fulfill({ contentType: 'text/html', body: DRAWN_PAGE });
      }
      if (url.startsWith(XHTML)) {
        return route.fulfill({ contentType: 'application/xhtml+xml', body: XHTML_PAGE });
      }
      if (url.startsWith(TREES)) {
        return route.fulfill({ contentType: 'text/html', body: TREES_PAGE });
      }
      if (url.startsWith(WEBFORM)) {
        return route.fulfill({ contentType: 'text/html', body: WEBFORM_PAGE });
      }
      if (url.startsWith(SLOW_START)) {
        return route.fulfill({ contentType: 'text/html', body: SLOW_START_PAGE });
      }
      if (url.startsWith(SLOW)) {
        slowRequests += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
        return route.fulfill({ contentType: 'text/html', body: '<title>Arrived</title>Arrived' });
      }
      if (url.startsWith(COVER)) {
        return route.fulfill({ contentType: 'text/html', body: COVER_PAGE });
      }
      if (url.startsWith(PAY)) {
        return route.fulfill({ contentType: 'text/html', body: PAY_PAGE });
      }
      if (url.startsWith(REACH)) {
        return route.fulfill({ contentType: 'text/html', body: REACH_PAGE });
      }
      if (url.startsWith(HARD)) {
        return route.fulfill({ contentType: 'text/html', body: HARD_PAGE });
      }
      if (url.startsWith(SHOP)) {
        return route.fulfill({ contentType: 'text/html', body: SHOP_PAGE });
      }
      if (url.startsWith('https://evil.example/')) {
        return route.fulfill({ contentType: 'text/html', body: DENIED_PAGE });
      }
      return route.abort();
    });
  });

  test.afterEach(async () => {
    if (session) {
      await session.close().catch(() => undefined);
      session.child?.kill();
      session = null;
    }
    // Chrome lets go of its profile a moment after it exits.
    for (let attempt = 0; profileDir && attempt < 20; attempt += 1) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        profileDir = '';
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
    }
  });

  // Open a page and run its acts in turn, stopping at the first that fails.
  async function openAndActAll(
    acts: AoiBrowserDriveActionRequest[],
    url = SHOP,
  ): Promise<AoiBrowserDriveStepResult[]> {
    const plan = {
      goal: 'shop',
      steps: [
        { description: 'open the shop', action: { kind: 'navigate' as const, url } },
        ...acts.map((action, index) => ({ description: `act ${index}`, action })),
      ],
    };
    const run = (stepIndex: number) =>
      executeAoiBrowserDriveStep({
        page: session?.page as unknown as AoiBrowserDriveActablePage,
        plan,
        stepIndex,
        allowlist: DENYLIST,
        approvalGate: async () => ({ approved: true }),
        now: Date.now(),
      });
    const opened = await run(0);
    expect(opened.ok).toBe(true);
    const results: AoiBrowserDriveStepResult[] = [];
    for (let index = 1; index <= acts.length; index += 1) {
      const result = await run(index);
      results.push(result);
      if (!result.ok) {
        break;
      }
    }
    return results;
  }

  // Open the shop, then run ONE act on it, the way a browser_drive_run call does.
  async function openAndAct(
    act: AoiBrowserDriveActionRequest,
    url = SHOP,
  ): Promise<AoiBrowserDriveStepResult> {
    const results = await openAndActAll([act], url);
    return results[results.length - 1];
  }

  test('reports the text the act put on the page and what it replaced', async () => {
    const result = await openAndAct({ kind: 'click', selector: '#add' });

    expect(result.ok).toBe(true);
    expect(result.afterAct?.textRead).toBe(true);
    expect(result.afterAct?.textAppeared).toContain('Added to cart');
    expect(result.afterAct?.textGone).toContain('Your cart is empty');
    // Evidence to read; the verdict still says nothing proved it.
    expect(result.verdict?.effect).toBe('unverifiable');
  });

  test('reports a confirm the act raised instead of timing out on it', async () => {
    const started = Date.now();
    const result = await openAndAct({ kind: 'click', selector: '#empty' });

    // This used to sit out the 15 s act timeout and come back as a failed click.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.ok).toBe(true);
    expect(result.afterAct?.dialog).toEqual({ type: 'confirm', message: 'Empty the cart?' });
    expect(result.afterAct?.textRead).toBe(false);
  });

  test('the audited execute path does not wait behind the dialog it raised', async () => {
    // The production path: the runner replays the reads, runs the act, and the
    // audit captures a screenshot and the DOM around it. With a dialog up, both
    // captures stall in Chrome -- so the audit has to step aside, or the act
    // sits behind its own record for half a minute.
    const artifactDir = fs.mkdtempSync(join(os.tmpdir(), 'aoi-drive-audit-'));
    const entries: Record<string, unknown>[] = [];
    const started = Date.now();
    try {
      const result = await executeAoiBrowserDriveActStep({
        plan: {
          goal: 'shop',
          steps: [
            { description: 'open the shop', action: { kind: 'navigate', url: SHOP } },
            { description: 'empty the cart', action: { kind: 'click', selector: '#empty' } },
          ],
        },
        targetStepIndex: 1,
        allowlist: DENYLIST,
        now: Date.now(),
        approvalGate: async () => ({ approved: true }),
        sessionFactory: async () => ({
          page: session?.page as unknown as AoiBrowserDriveActablePage,
          close: async () => undefined,
        }),
        audit: {
          runId: 'e2e-dialog',
          writeArtifact: (relPath, data) => {
            const target = join(artifactDir, relPath);
            fs.mkdirSync(join(target, '..'), { recursive: true });
            fs.writeFileSync(target, data);
          },
          recordEntry: (entry) => {
            entries.push(entry as unknown as Record<string, unknown>);
          },
        },
      });

      expect(Date.now() - started).toBeLessThan(15_000);
      expect('target' in result && result.target.afterAct?.dialog).toEqual({
        type: 'confirm',
        message: 'Empty the cart?',
      });
      // Both steps are on the record; the act's own capture was skipped, not hung.
      expect(entries).toHaveLength(2);
      expect(entries[1]).toMatchObject({ stepIndex: 1, ok: true });
    } finally {
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  test('reports a route change that lands a moment after the click, without crediting it', async () => {
    const result = await openAndAct({ kind: 'click', selector: '#details' });

    expect(result.afterAct?.urlChanged).toBe(true);
    expect(result.finalUrl).toBe('https://shop.example/details');
    // The route changed 200 ms after the click returned. The look reports it;
    // the verdict does not credit the click with it, since a page routes on its
    // own too.
    expect(result.verdict?.effect).toBe('unverifiable');
    expect(result.afterAct?.textAppeared).toContain('Item details');
  });

  test('refuses Enter in a field whose form pays, however the field is addressed', async () => {
    // `form:has(<selector>)` was not even valid for Playwright's own selectors,
    // so the check read nothing and Enter submitted the form.
    for (const selector of [
      '#holder',
      'role=textbox[name="Card holder"]',
      'text=Card holder >> input',
    ]) {
      const result = await openAndAct({ kind: 'press', selector, key: 'Enter' }, PAY);
      expect(result.ok, selector).toBe(false);
      expect(result.stopReason, selector).toBe('forbidden');
      expect(await (session?.page as unknown as Page).title(), selector).toBe('Pay');
    }
  });

  test('refuses Enter in a field that belongs to a paying form from outside it', async () => {
    const result = await openAndAct({ kind: 'press', selector: '#qty', key: 'Enter' }, PAY);
    expect(result.stopReason).toBe('forbidden');
    expect(await (session?.page as unknown as Page).title()).toBe('Pay');
  });

  test('judges Enter by the button it presses, not by the rest of the form', async () => {
    // The form says "checkout" and has a "Buy now" button, but Enter presses
    // its first submit button, "Search".
    const result = await openAndAct({ kind: 'press', selector: '#find', key: 'Enter' }, PAY);
    expect(result.ok).toBe(true);
    expect(await (session?.page as unknown as Page).title()).toBe('shop searched');
  });

  test('lets Enter through in an ordinary search form, without a long wait', async () => {
    const started = Date.now();
    const result = await openAndAct({ kind: 'press', selector: '#q', key: 'Enter' }, PAY);
    expect(result.ok).toBe(true);
    expect(await (session?.page as unknown as Page).title()).toBe('searched');
    // The reads around the field that find nothing wait half a second, not three.
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test('judges the element an act reaches, not only the one its selector names', async () => {
    // Each of these selectors names something harmless; each act would have
    // reached a password, a card number or a pay button.
    const page = () => session?.page as unknown as Page;
    for (const act of [
      { kind: 'type', selector: 'label[for=pw]', text: 'hunter2' },
      { kind: 'type', selector: 'text=Card number', text: '4111111111111111' },
      { kind: 'click', selector: 'label[for=paybtn]' },
      { kind: 'click', selector: '#checkout i' },
      { kind: 'click', selector: '#buyimg' },
      { kind: 'click', selector: '#imgbtn' },
      { kind: 'press', selector: '#heading', key: 'Enter' },
      { kind: 'type', selector: '#cardNo', text: '1234' },
    ] as AoiBrowserDriveActionRequest[]) {
      const result = await openAndAct(act, REACH);
      const label = JSON.stringify(act);
      expect(result.stopReason, label).toBe('forbidden');
      expect(await page().title(), label).toBe('Reach');
      expect(await page().inputValue('#pw'), label).toBe('');
      expect(await page().inputValue('#cc'), label).toBe('');
    }
  });

  test('judges a target as it is when it can take the act, not as it was asked about', async () => {
    // A disabled "Continue" that becomes an enabled "Pay now" a moment later.
    const result = await openAndAct({ kind: 'click', selector: '#later' }, REACH);
    expect(result.stopReason).toBe('forbidden');
    expect(await (session?.page as unknown as Page).title()).toBe('Reach');
  });

  test('judges Enter by what the browser itself would press or submit', async () => {
    // A shadow button the browser does not count, a field in a frame, a form
    // with no button at all, and a form the parser tied to its controls
    // without holding them -- in each, Enter would pay.
    const page = () => session?.page as unknown as Page;
    for (const selector of [
      '#amt1',
      '#fr >> internal:control=enter-frame >> #amt2',
      '#amt3',
      '#amt4',
    ]) {
      const result = await openAndAct({ kind: 'press', selector, key: 'Enter' }, HARD);
      expect(result.stopReason, selector).toBe('forbidden');
      expect(await page().title(), selector).toBe('Hard');
    }
  });

  test('judges a key where focus really lands, and what it lands on', async () => {
    const page = () => session?.page as unknown as Page;
    // A disabled field cannot take focus: Enter goes to the focused card field.
    // A box with a key handler is what Space activates.
    for (const act of [
      { kind: 'press', selector: '#dis', key: 'Enter' },
      { kind: 'press', selector: '#tbox', key: ' ' },
    ] as AoiBrowserDriveActionRequest[]) {
      const result = await openAndAct(act, HARD);
      expect(result.stopReason, JSON.stringify(act)).toBe('forbidden');
      expect(await page().title(), JSON.stringify(act)).toBe('Hard');
    }
  });

  test('judges a click by what labels it and what it sits in', async () => {
    const page = () => session?.page as unknown as Page;
    for (const act of [
      // A checkbox whose label buys; a price beside "Buy now" in a scripted box.
      { kind: 'click', selector: '#oneclick' },
      { kind: 'click', selector: '#price' },
    ] as AoiBrowserDriveActionRequest[]) {
      const result = await openAndAct(act, HARD);
      expect(result.stopReason, JSON.stringify(act)).toBe('forbidden');
      expect(await page().title(), JSON.stringify(act)).toBe('Hard');
    }
    // An icon with nothing to say. In a box that shows nothing else, the box's
    // words -- a description for screen readers, placed off the screen -- say
    // what a click does; in a box too long to be its label, nothing does.
    const mute = await openAndAct({ kind: 'click', selector: '#mute' }, HARD);
    expect(mute.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Hard');
    const longBox = await openAndAct({ kind: 'click', selector: '#mute2' }, HARD);
    expect(longBox.detail).toContain('target_unreadable');
    expect(await page().title()).toBe('Hard');
  });

  test('judges a click as the target is once nothing covers it', async () => {
    // "Continue" under an overlay that, when it goes, leaves "Pay now".
    const result = await openAndAct({ kind: 'click', selector: '#next' }, HARD);
    expect(result.stopReason).toBe('forbidden');
    expect(await (session?.page as unknown as Page).title()).toBe('Hard');
  });

  test('fills no field a label leads to without judging it', async () => {
    // contenteditable=" false" is not editable, so the fill goes to the
    // label's control: the password field.
    const result = await openAndAct({ kind: 'type', selector: '#note', text: 'hunter2' }, HARD);
    expect(result.stopReason).toBe('forbidden');
    expect(await (session?.page as unknown as Page).inputValue('#pw2')).toBe('');
  });

  test('still lets an ordinary click on the same page through', async () => {
    const result = await openAndAct({ kind: 'click', selector: '#details' }, REACH);
    expect(result.ok).toBe(true);
    expect(await (session?.page as unknown as Page).title()).toBe('DETAILS');
  });

  test('looks up a label, a name and a form in the shadow tree the field is in', async () => {
    const page = () => session?.page as unknown as Page;
    for (const act of [
      { kind: 'type', selector: '#f1', text: 'hunter2' },
      { kind: 'type', selector: '#f2', text: '4111111111111111' },
      { kind: 'click', selector: '#lb' },
    ] as AoiBrowserDriveActionRequest[]) {
      const result = await openAndAct(act, TREES);
      expect(result.stopReason, JSON.stringify(act)).toBe('forbidden');
      expect(await page().title(), JSON.stringify(act)).toBe('Trees');
    }
  });

  test('judges a key where focus really is: in a frame, inside a component', async () => {
    const page = () => session?.page as unknown as Page;
    // Typing into the frame's field is fine; Enter "on" a note beside the
    // frame goes into that field all the same, and its form pays.
    const framed = await openAndActAll(
      [
        { kind: 'type', selector: '#pf >> internal:control=enter-frame >> #zip', text: '12345' },
        { kind: 'press', selector: '#notes', key: 'Enter' },
      ],
      TREES,
    );
    expect(framed[0].ok).toBe(true);
    expect(framed[1]?.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Trees');
    // A component that passes focus to a field inside: Enter there pays...
    const paying = await openAndAct({ kind: 'press', selector: '#df', key: 'Enter' }, TREES);
    expect(paying.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Trees');
    // ...unless the form inside only searches.
    const searching = await openAndAct({ kind: 'press', selector: '#ds', key: 'Enter' }, TREES);
    expect(searching.ok, JSON.stringify(searching)).toBe(true);
    expect(await page().title()).toBe('SUBMIT:ds');
  });

  test('does not send a key once its field hands focus to a pay button', async () => {
    const result = await openAndAct({ kind: 'press', selector: '#mv', key: 'Enter' }, TREES);
    expect(result.ok).toBe(false);
    expect(await (session?.page as unknown as Page).title()).toBe('Trees');
  });

  test('reads every default button and the words around a button that says none', async () => {
    const page = () => session?.page as unknown as Page;
    for (const act of [
      // The fourth of four forms the parser opened in one table.
      { kind: 'press', selector: '#td', key: 'Enter' },
      // A default button nobody can see.
      { kind: 'press', selector: '#hid', key: 'Enter' },
      // An icon five wrappers deep in a box that buys.
      { kind: 'click', selector: '#deep' },
      // An icon button beside "Pay now".
      { kind: 'click', selector: '#mute' },
    ] as AoiBrowserDriveActionRequest[]) {
      const result = await openAndAct(act, TREES);
      expect(result.stopReason, JSON.stringify(act)).toBe('forbidden');
      expect(await page().title(), JSON.stringify(act)).toBe('Trees');
    }
  });

  test('lets through what commits nothing, and a search a page-wide form runs', async () => {
    const page = () => session?.page as unknown as Page;
    const hovered = await openAndAct({ kind: 'hover', selector: '#menu' }, TREES);
    expect(hovered.ok).toBe(true);
    expect(await page().title()).toBe('HOVERED');
    // The form says "Cart" and "Checkout"; its default button is the search icon.
    const searched = await openAndAct({ kind: 'press', selector: '#aq', key: 'Enter' }, WEBFORM);
    expect(searched.ok).toBe(true);
    expect(await page().title()).toBe('SUBMIT:go');
  });

  test('reports a click whose page takes seconds to load as delivered, and sends it once', async () => {
    const result = await openAndAct({ kind: 'click', selector: '#go' }, SLOW_START);
    expect(result.ok).toBe(true);
    expect(result.verdict?.effect).toBe('confirmed');
    expect(result.finalUrl).toBe(SLOW);
    expect(slowRequests).toBe(1);
  });

  test('clicks a link that wraps and a button under a fixed header without a long wait', async () => {
    const page = () => session?.page as unknown as Page;
    for (const [selector, title] of [
      ['#wrap', 'WRAPPED'],
      ['#more', 'MORE'],
    ]) {
      const started = Date.now();
      const result = await openAndAct({ kind: 'click', selector }, COVER);
      expect(result.ok, selector).toBe(true);
      expect(await page().title(), selector).toBe(title);
      expect(Date.now() - started, selector).toBeLessThan(6_000);
    }
  });

  test('reads what a component draws in its own tree, and refuses what none can read', async () => {
    const page = () => session?.page as unknown as Page;
    for (const act of [
      // "Pay now" drawn in a shadow tree: neither innerText nor textContent.
      { kind: 'click', selector: '#drawn' },
      // A price drawn in a component, in a box that buys outside it.
      { kind: 'click', selector: 'x-price #price' },
      // Enter in a field the parser tied to a form whose button pays.
      { kind: 'press', selector: '#owned', key: 'Enter' },
    ] as AoiBrowserDriveActionRequest[]) {
      const result = await openAndAct(act, DRAWN);
      expect(result.stopReason, JSON.stringify(act)).toBe('forbidden');
      expect(await page().title(), JSON.stringify(act)).toBe('Drawn');
    }
    // A pay button in a closed shadow tree: no page read reaches it, and the
    // browser's own hit test, where the click lands, does.
    const sealed = await openAndAct({ kind: 'click', selector: '#sealed' }, DRAWN);
    expect(sealed.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Drawn');
    // A button whose name a component slots in is read, and goes through.
    const saved = await openAndAct({ kind: 'click', selector: 'role=button[name="Save"]' }, DRAWN);
    expect(saved.ok).toBe(true);
    expect(await page().title()).toBe('SAVED');
  });

  test('judges an XHTML page by the same elements as an HTML one', async () => {
    const page = () => session?.page as unknown as Page;
    const typed = await openAndAct(
      { kind: 'type', selector: 'label[for=xpw]', text: 'hunter2' },
      XHTML,
    );
    expect(typed.stopReason).toBe('forbidden');
    // Playwright's own inputValue reads no XHTML input; the page's value says.
    expect(
      await page()
        .locator('#xpw')
        .evaluate((field) => (field as HTMLInputElement).value),
    ).toBe('');
    const clicked = await openAndAct({ kind: 'click', selector: 'label[for=xpay]' }, XHTML);
    expect(clicked.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Xhtml');
    const searched = await openAndAct({ kind: 'press', selector: '#xq', key: 'Enter' }, XHTML);
    expect(searched.ok).toBe(true);
    expect(await page().title()).toBe('SEARCHED');
  });

  test('reads past glyphs, made-up names and containers to what an act really presses', async () => {
    const page = () => session?.page as unknown as Page;
    for (const act of [
      // An icon font's glyph beside "Buy now".
      { kind: 'click', selector: '#glyph' },
      // A submit input the page did not name ("Submit" is the browser's word).
      { kind: 'click', selector: '#unnamed' },
      // A panel of text whose centre, where the click lands, is a pay button.
      { kind: 'click', selector: '#panel' },
      // A name written in brackets, drawn in a shadow tree.
      { kind: 'click', selector: '#bracket' },
      // A price drawn in a component, in a box that buys, in a form whose
      // named control stands in for its "matches".
      { kind: 'click', selector: 'x-price #price' },
      // A field labelled only by words drawn in a shadow tree.
      { kind: 'type', selector: '#cardf', text: '4111111111111111' },
    ] as AoiBrowserDriveActionRequest[]) {
      const result = await openAndAct(act, WORDS);
      expect(result.stopReason, JSON.stringify(act)).toBe('forbidden');
      expect(await page().title(), JSON.stringify(act)).toBe('Words');
    }
    // A button that holds a component no page read reaches, in a row giving a
    // total -- even one that holds an empty element of its own: the browser's
    // hit test reads what it draws where the click lands.
    for (const selector of ['#holds', '#emptyspan']) {
      const holds = await openAndAct({ kind: 'click', selector }, WORDS);
      expect(holds.stopReason, selector).toBe('forbidden');
      expect(await page().title(), selector).toBe('Words');
    }
    // An icon component that draws its svg in plain view is not sealed.
    const liked = await openAndAct({ kind: 'click', selector: '#liked' }, WORDS);
    expect(liked.ok).toBe(true);
    expect(await page().title()).toBe('LIKED');
    // A mute button is read by all its row shows, what a component in it draws
    // included: "Checkout (2)" drawn by a cart beside it is beside it.
    const menu = await openAndAct({ kind: 'click', selector: '#menu' }, WORDS);
    expect(menu.ok).toBe(false);
    expect(await page().title()).toBe('Words');
  });

  test('judges a click by what the browser finds where it lands', async () => {
    const page = () => session?.page as unknown as Page;
    for (const act of [
      // A panel whose centre is a component, in a closed tree, that pays.
      { kind: 'click', selector: '#wallet' },
      // A button inside a link that buys: the link's own action runs too.
      { kind: 'click', selector: '#details' },
      // An image whose map area, where the click lands, buys.
      { kind: 'click', selector: '#map' },
      // A frame from another site whose button pays.
      { kind: 'click', selector: '#payframe' },
      // A panel whose centre is a label for a hidden pay button.
      { kind: 'click', selector: '#options' },
      // A key on a player inside a button that pays.
      { kind: 'press', selector: '#vid', key: 'Enter' },
    ] as AoiBrowserDriveActionRequest[]) {
      const result = await openAndAct(act, AIMED);
      expect(result.stopReason, JSON.stringify(act)).toBe('forbidden');
      expect(await page().title(), JSON.stringify(act)).toBe('Aimed');
    }
    // A component behind a space nobody sees, in a frame the browser is not
    // asked about: not clicked.
    const own = await openAndAct(
      { kind: 'click', selector: '#own >> internal:control=enter-frame >> #sp' },
      AIMED,
    );
    expect(own.detail).toContain('target_unreadable');
    expect(await page().title()).toBe('Aimed');
  });

  test('judges a box by all it draws, a field as it is once focused, and checkout words', async () => {
    const page = () => session?.page as unknown as Page;
    for (const act of [
      // A box whose pay label is drawn in a closed shadow tree away from where
      // the click lands, or by another site's frame, or in a closed tree on a
      // plain element.
      { kind: 'click', selector: '#decoy' },
      { kind: 'click', selector: '#framed' },
      { kind: 'click', selector: '#plain' },
      // A search box that turns into a card number field once focused.
      { kind: 'type', selector: '#search', text: '4111111111111111' },
      // Enter in a form whose button places the order; a card's expiry, under
      // its card details.
      { kind: 'press', selector: '#coupon', key: 'Enter' },
      { kind: 'type', selector: '#exp', text: '1225' },
    ] as AoiBrowserDriveActionRequest[]) {
      const result = await openAndAct(act, BOXES);
      expect(result.stopReason, JSON.stringify(act)).toBe('forbidden');
      expect(await page().title(), JSON.stringify(act)).toBe('Boxes');
    }
    expect(
      await page()
        .locator('#search')
        .evaluate((field) => (field as HTMLInputElement).value),
    ).toBe('');
    // A coupon's expiry is no card's.
    const coupon = await openAndAct(
      { kind: 'type', selector: '#couponexp', text: '12/31/2026' },
      BOXES,
    );
    expect(coupon.ok, JSON.stringify([coupon.stopReason, coupon.detail])).toBe(true);
    for (const [act, title] of [
      // A button under a layer the pointer goes through, which says "Buy now".
      [{ kind: 'click', selector: '#menu' }, 'MENU'],
      // A list of past purchases is no purchase.
      [{ kind: 'click', selector: '#history' }, 'HISTORY'],
    ] as [AoiBrowserDriveActionRequest, string][]) {
      const result = await openAndAct(act, BOXES);
      expect(result.ok, JSON.stringify(act)).toBe(true);
      expect(await page().title(), JSON.stringify(act)).toBe(title);
    }
  });

  test('reads what is drawn but kept from the read-out, and not what is not drawn', async () => {
    const page = () => session?.page as unknown as Page;
    for (const act of [
      // A box whose pay label is aria-hidden in a shadow tree, beside "Details".
      { kind: 'click', selector: '#hiddenpay' },
      // A one-time code and a tip, in the words sites use.
      { kind: 'type', selector: '#otp', text: '123456' },
      { kind: 'click', selector: '#tip' },
    ] as AoiBrowserDriveActionRequest[]) {
      const result = await openAndAct(act, DRAWN_ONLY);
      expect(result.stopReason, JSON.stringify(act)).toBe('forbidden');
      expect(await page().title(), JSON.stringify(act)).toBe('Drawn only');
    }
    // Menus whose hidden lists hold "Buy gift cards": the lists are not drawn.
    for (const [selector, title] of [
      ['#shopnav', 'MENU'],
      ['#giftnav', 'GIFTS'],
    ]) {
      const menu = await openAndAct({ kind: 'click', selector }, MENU);
      expect(menu.ok, JSON.stringify([selector, menu.stopReason, menu.detail])).toBe(true);
      expect(await page().title()).toBe(title);
    }
    // A button among thirty thousand siblings is read, and in time.
    const started = Date.now();
    const crowd = await openAndAct({ kind: 'click', selector: '#open' }, CROWD);
    expect(crowd.ok, JSON.stringify([crowd.stopReason, crowd.detail])).toBe(true);
    expect(await page().title()).toBe('OPENED');
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  test("reads a component's form, what CSS draws, a human check, a big hidden menu and a crowded feed", async () => {
    const page = () => session?.page as unknown as Page;
    for (const act of [
      // Enter in a field of a component's shadow tree submits the form around it.
      { kind: 'press', selector: '#email', key: 'Enter' },
      // A card whose "Buy now" is drawn by CSS, under aria-hidden.
      { kind: 'click', selector: '#plan' },
      // A human check that never says "captcha".
      { kind: 'click', selector: '#human' },
    ] as AoiBrowserDriveActionRequest[]) {
      const result = await openAndAct(act, ROUND11);
      expect(result.stopReason, JSON.stringify(act)).toBe('forbidden');
      expect(await page().title(), JSON.stringify(act)).toBe('Round 11');
    }
    // A menu button that says nothing, beside a drawer of 49 links not drawn.
    const menu = await openAndAct({ kind: 'click', selector: '#burger' }, ROUND11);
    expect(menu.ok, JSON.stringify([menu.stopReason, menu.detail])).toBe(true);
    expect(await page().title()).toBe('OPENED');
    // A pay widget from another site, clicked in a feed of 2,100 cards.
    const widget = await openAndAct({ kind: 'click', selector: '#widget' }, FEED);
    expect(widget.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Feed');
  });

  test('lets a click into a field through, and reads a long form that components submit', async () => {
    const page = () => session?.page as unknown as Page;
    // A field a click only focuses: the date a stay ends, a sum to transfer.
    for (const [selector, title] of [
      ['#checkout-date', 'PICKER'],
      ['#amount', 'AMOUNT'],
    ] as const) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND12);
      expect(result.ok, JSON.stringify([selector, result.stopReason, result.detail])).toBe(true);
      await expect.poll(() => page().title(), { timeout: 5_000 }).toBe(title);
    }
    // One in a pay button is the button's.
    const inButton = await openAndAct({ kind: 'click', selector: '#quantity' }, ROUND12);
    expect(inButton.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Round 12');
    // Enter in a component's field submits a long form a component pays.
    for (const selector of ['#promo', '#promo input']) {
      const result = await openAndAct({ kind: 'press', selector, key: 'Enter' }, ROUND12);
      expect(result.stopReason, selector).toBe('forbidden');
      expect(await page().title(), selector).toBe('Round 12');
    }
    // A form of many buttons that say little is read through and submitted;
    // one whose buttons say more than is read is not.
    const filters = await openAndAct(
      { kind: 'press', selector: '#filter-q', key: 'Enter' },
      ROUND12,
    );
    expect(filters.ok, JSON.stringify([filters.stopReason, filters.detail])).toBe(true);
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('FILTERED');
    const huge = await openAndAct({ kind: 'press', selector: '#huge-q', key: 'Enter' }, ROUND12);
    expect(huge.detail).toContain('in a form too large to read through');
    expect(await page().title()).toBe('Round 12');
  });

  test('clicks labels of fields and a box of them, and not a field in a row that buys', async () => {
    const page = () => session?.page as unknown as Page;
    // A label of a date only focuses it; a search box of labelled dates opens.
    for (const [selector, title] of [
      ['#co-label', 'PICKER'],
      ['#search', 'SEARCH_OPEN'],
    ] as const) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND13);
      expect(result.ok, JSON.stringify([selector, result.stopReason, result.detail])).toBe(true);
      await expect.poll(() => page().title(), { timeout: 5_000 }).toBe(title);
    }
    // A field in a row that buys on a click is the row's.
    const row = await openAndAct({ kind: 'click', selector: '#qty' }, ROUND13);
    expect(row.stopReason).toBe('forbidden');
    // Enter submits a form a link pays with.
    const give = await openAndAct({ kind: 'press', selector: '#receipt', key: 'Enter' }, ROUND13);
    expect(give.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Round 13');
  });

  test('accepts a confirm that cancels a priced plan, not one that pays after a negation', async () => {
    const page = () => session?.page as unknown as Page;
    const accept = { kind: 'dialog', disposition: 'accept' } as AoiBrowserDriveActionRequest;
    const cancelled = await openAndActAll(
      [{ kind: 'click', selector: '#cancel-plan' }, accept],
      ROUND13,
    );
    expect(
      cancelled.every((step) => step.ok),
      JSON.stringify(cancelled.map((step) => [step.stopReason, step.detail])),
    ).toBe(true);
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('CANCELLED');
    // "won't be charged" takes nothing away from "pay $49.00 now" after it.
    const paid = await openAndActAll([{ kind: 'click', selector: '#go-on' }, accept], ROUND13);
    // (The confirm stays open, the page behind it waiting on the answer.)
    expect(paid.map((step) => step.stopReason)).toEqual([undefined, 'forbidden']);
  });

  test('refuses a human check named by its heading, not a dialog that sets one up', async () => {
    const page = () => session?.page as unknown as Page;
    const begin = await openAndAct({ kind: 'click', selector: '#begin' }, ROUND13_DIALOGS);
    expect(begin.detail).toContain('CAPTCHA');
    expect(await page().title()).toBe('Round 13 dialogs');
    const cancel = await openAndAct(
      { kind: 'click', selector: '#cancel-settings' },
      ROUND13_DIALOGS,
    );
    expect(cancel.ok, JSON.stringify([cancel.stopReason, cancel.detail])).toBe(true);
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('CANCELLED');
  });

  test('lets Enter through in a search box above a long list, without a long wait', async () => {
    const page = () => session?.page as unknown as Page;
    const started = Date.now();
    const result = await openAndAct(
      { kind: 'press', selector: '#cq', key: 'Enter' },
      CROWDED_SEARCH,
    );
    expect(result.ok, JSON.stringify([result.stopReason, result.detail])).toBe(true);
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('SEARCHED');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  test('lets through what the browser finds says nothing to refuse', async () => {
    const page = () => session?.page as unknown as Page;
    for (const [act, title] of [
      // A frame from another site, of many controls, whose middle plays.
      [{ kind: 'click', selector: '#player' }, 'PLAYED'],
      // A link named for a password is a link.
      [{ kind: 'press', selector: '#forgot', key: 'Enter' }, 'FORGOT'],
      // An icon its stylesheet draws, beside what it does.
      [{ kind: 'click', selector: '#heart' }, 'LIKED'],
    ] as [AoiBrowserDriveActionRequest, string][]) {
      const result = await openAndAct(act, AIMED);
      expect(result.ok, JSON.stringify(act)).toBe(true);
      await expect.poll(() => page().title(), { timeout: 5_000 }).toBe(title);
    }
    // A plain button on a page of forty thousand elements.
    const more = await openAndAct({ kind: 'click', selector: '#more' }, BIG);
    expect(more.ok).toBe(true);
    expect(await page().title()).toBe('MORE');
  });

  test("does not wait on a page that never answers the drive's own calls", async () => {
    // What Enter would press is the page's to say, and it never does: the key
    // is not sent, and not after a long wait either.
    const started = Date.now();
    const result = await openAndAct({ kind: 'press', selector: '#sq', key: 'Enter' }, STALL);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.detail).toContain('could not be checked in time');
    expect(await (session?.page as unknown as Page).title()).toBe('Stall');
  });

  test('judges what a label holds and the box a control is in, not a box around the page', async () => {
    const page = () => session?.page as unknown as Page;
    // A label that pays on its own click, one that holds a Donate button, and a
    // Details button in a box that buys on a click.
    // And a quantity field drawn in a component that buys on a click.
    for (const selector of ['#pay-label', '#donate-label', '#details', '#qty-host >> input']) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND14);
      expect(result.stopReason, selector).toBe('forbidden');
      expect(await page().title(), selector).toBe('Round 14');
    }
    // A box around the whole basket that counts clicks says nothing of one.
    const more = await openAndAct({ kind: 'click', selector: '#more14' }, ROUND14);
    expect(more.ok, JSON.stringify([more.stopReason, more.detail])).toBe(true);
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('MORE');
    // Enter submits a form whose pay link is drawn deep in a box that counts
    // clicks.
    const give = await openAndAct({ kind: 'press', selector: '#receipt14', key: 'Enter' }, ROUND14);
    expect(give.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Round 14');
  });

  test("refuses a card's expiry in a section of its form, whatever the plan calls it", async () => {
    const page = () => session?.page as unknown as Page;
    for (const field of [undefined, { title: 'membership' }]) {
      const result = await openAndAct(
        { kind: 'type', selector: '#exp14', text: '12/29', ...(field ? { field } : {}) },
        ROUND14,
      );
      expect(result.stopReason, JSON.stringify(field)).toBe('forbidden');
      expect(await page().title()).toBe('Round 14');
    }
    // A legend that names what the card buys does not make its expiry another's.
    const gift = await openAndAct({ kind: 'type', selector: '#gift-exp', text: '12/29' }, ROUND14);
    expect(gift.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Round 14');
    // A traveller's expiry, in a section of its own outside any form, is typed.
    const traveller = await openAndAct(
      { kind: 'type', selector: '#doe14', text: '12/29' },
      ROUND14,
    );
    expect(traveller.ok, JSON.stringify([traveller.stopReason, traveller.detail])).toBe(true);
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('TYPED');
  });

  test('acts on a page once the one that asked something is navigated away from', async () => {
    const page = () => session?.page as unknown as Page;
    const steps = await openAndActAll(
      [
        { kind: 'wait', value: '800' },
        { kind: 'navigate', url: ROUND14 },
        { kind: 'click', selector: '#more14' },
      ],
      ROUND14_ALERT,
    );
    expect(
      steps.map((step) => step.ok),
      JSON.stringify(steps.map((step) => [step.stopReason, step.detail])),
    ).toEqual([true, true, true]);
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('MORE');
  });

  test('lets Enter through on a page-wide form of a thousand rows, without a long wait', async () => {
    const page = () => session?.page as unknown as Page;
    const started = Date.now();
    const result = await openAndAct({ kind: 'press', selector: '#gq', key: 'Enter' }, GRID);
    expect(result.ok, JSON.stringify([result.stopReason, result.detail])).toBe(true);
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('SUBMITTED');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  test('does not accept a payment the next page asks for by the alert of the page before', async () => {
    const page = () => session?.page as unknown as Page;
    const plan = {
      goal: 'shop',
      steps: [
        { description: 'open the cart', action: { kind: 'navigate' as const, url: ROUND15_ALERT } },
        { description: 'wait', action: { kind: 'wait' as const, value: '800' } },
        { description: 'go to checkout', action: { kind: 'navigate' as const, url: ROUND15_PAY } },
        {
          description: 'accept',
          action: { kind: 'dialog', disposition: 'accept' } as AoiBrowserDriveActionRequest,
        },
      ],
    };
    const results: AoiBrowserDriveStepResult[] = [];
    for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
      results.push(
        await executeAoiBrowserDriveStep({
          page: session?.page as unknown as AoiBrowserDriveActablePage,
          plan,
          stepIndex,
          allowlist: DENYLIST,
          approvalGate: async () => ({ approved: true }),
          now: Date.now(),
          timeoutMs: 3_000,
        }),
      );
    }
    // The checkout never finishes loading: its confirm holds it. The alert of
    // the cart the browser closed is not what the accept is judged by.
    const accept = results[3];
    expect(accept.stopReason, JSON.stringify(results.map((r) => [r.stopReason, r.detail]))).toBe(
      'forbidden',
    );
    expect(accept.detail).toContain('dialog');
    await (session?.page as unknown as { answerDialog(d: string): Promise<string> }).answerDialog(
      'dismiss',
    );
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('NOTPAID');
  });

  test('measures a box by what it draws, reads components in components, not sibling buttons', async () => {
    const page = () => session?.page as unknown as Page;
    // A row that draws "Buy now $49.00" around the quantity, a style sheet in
    // its markup; a card whose price a component in it draws.
    for (const selector of ['#qty15', '#card15 >> #cq15']) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND15);
      expect(result.stopReason, selector).toBe('forbidden');
      expect(await page().title(), selector).toBe('Round 15');
    }
    // A wishlist button beside a "Buy now" in a component's tile, and a
    // wordmark of two colours.
    for (const [selector, title] of [
      ['#tile15 >> #wish15', 'SAVED'],
      ['#paypal15', 'LOGIN'],
    ] as const) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND15);
      expect(result.ok, JSON.stringify([selector, result.stopReason, result.detail])).toBe(true);
      await expect.poll(() => page().title(), { timeout: 5_000 }).toBe(title);
    }
  });

  test("types a passenger's expiry beside a card form, and not the card's", async () => {
    const page = () => session?.page as unknown as Page;
    const card = await openAndAct(
      { kind: 'type', selector: '#card-exp15', text: '12/29' },
      ROUND15,
    );
    expect(card.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Round 15');
    const passenger = await openAndAct(
      { kind: 'type', selector: '#pax-exp15', text: '12/29' },
      ROUND15,
    );
    expect(passenger.ok, JSON.stringify([passenger.stopReason, passenger.detail])).toBe(true);
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('TYPED');
  });

  test('measures a box by what it shows, not by a description it hides', async () => {
    const page = () => session?.page as unknown as Page;
    // "Buy now $49.00" is all the row shows: a click on its quantity buys.
    const row = await openAndAct({ kind: 'click', selector: '#qty16' }, ROUND16);
    expect(row.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Round 16');
    // A card that shows all of its text is long: a click in its field only focuses it.
    const card = await openAndAct({ kind: 'click', selector: '#note16' }, ROUND16);
    expect(card.ok, JSON.stringify([card.stopReason, card.detail])).toBe(true);
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('OPENED');
  });

  test("reads a total that names its Cancel button, an amount inside a pay button, and a card's expiry", async () => {
    const page = () => session?.page as unknown as Page;
    const [click, accept] = await openAndActAll(
      [
        { kind: 'click', selector: '#total16' },
        { kind: 'dialog', disposition: 'accept' } as AoiBrowserDriveActionRequest,
      ],
      ROUND16,
    );
    expect(click.ok).toBe(true);
    expect(accept.stopReason).toBe('forbidden');
    await (session?.page as unknown as { answerDialog(d: string): Promise<string> }).answerDialog(
      'dismiss',
    );
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('NOTPAID');
    const submit = await openAndAct({ kind: 'click', selector: '#submit16' }, ROUND16);
    expect(submit.stopReason).toBe('forbidden');
    const expiry = await openAndAct({ kind: 'type', selector: '#exp16', text: '12/2030' }, ROUND16);
    expect(expiry.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Round 16');
  });

  test('says a page asks as it loads, without waiting the load out', async () => {
    const page = () => session?.page as unknown as Page;
    const plan = {
      goal: 'shop',
      steps: [
        { description: 'go to checkout', action: { kind: 'navigate' as const, url: ROUND15_PAY } },
        {
          description: 'accept',
          action: { kind: 'dialog', disposition: 'accept' } as AoiBrowserDriveActionRequest,
        },
      ],
    };
    const run = (stepIndex: number) =>
      executeAoiBrowserDriveStep({
        page: session?.page as unknown as AoiBrowserDriveActablePage,
        plan,
        stepIndex,
        allowlist: DENYLIST,
        approvalGate: async () => ({ approved: true }),
        now: Date.now(),
        timeoutMs: 20_000,
      });
    const started = Date.now();
    const navigated = await run(0);
    // The checkout never finishes loading while its confirm waits: said at once.
    expect(navigated.detail).toContain('dialog_raised');
    expect(navigated.finalUrl).toBe(ROUND15_PAY);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await run(1)).stopReason).toBe('forbidden');
    await (session?.page as unknown as { answerDialog(d: string): Promise<string> }).answerDialog(
      'dismiss',
    );
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('NOTPAID');
  });

  test('does not hold a dialog a frame raised, so the page cannot crash the browser by removing it', async () => {
    const plan = {
      goal: 'help',
      steps: [
        { description: 'open help', action: { kind: 'navigate' as const, url: ROUND17_FRAME } },
        { description: 'wait', action: { kind: 'wait' as const, value: '2500' } },
        { description: 'go on', action: { kind: 'navigate' as const, url: SHOP } },
      ],
    };
    const results: AoiBrowserDriveStepResult[] = [];
    for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
      results.push(
        await executeAoiBrowserDriveStep({
          page: session?.page as unknown as AoiBrowserDriveActablePage,
          plan,
          stepIndex,
          allowlist: DENYLIST,
          approvalGate: async () => ({ approved: true }),
          now: Date.now(),
        }),
      );
    }
    // The widget's hello was dismissed as it came; the page took the widget
    // away; the browser lives on and the drive goes on.
    expect(
      results.map((r) => r.ok),
      JSON.stringify(results.map((r) => r.detail)),
    ).toEqual([true, true, true]);
    expect((session?.page as unknown as { pendingDialog(): unknown }).pendingDialog()).toBeNull();
    expect((session?.page as unknown as Page).url()).toBe(SHOP);
  });

  test('reads around the slot of a closed tree, and a box of floats by what it shows', async () => {
    const page = () => session?.page as unknown as Page;
    for (const selector of ['#det17', '#det17b']) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND17);
      expect(result.stopReason, selector).toBe('forbidden');
      expect(await page().title(), selector).toBe('Round 17');
    }
  });

  test("clicks what a <details> or a list box puts in the browser's own trees, without bringing the tab down", async () => {
    const page = () => session?.page as unknown as Page;
    for (const selector of ['#sum18', '#lnk18']) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND18);
      expect(result.ok, `${selector} ${JSON.stringify([result.stopReason, result.detail])}`).toBe(
        true,
      );
      expect(
        await page()
          .mainFrame()
          .evaluate(() => 1 + 1),
        selector,
      ).toBe(2);
    }
  });

  test('reads every closed pay box a control is slotted through, in components and fields', async () => {
    const page = () => session?.page as unknown as Page;
    for (const selector of ['#det18', '#qty18 input', '#det18c']) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND18);
      expect(result.stopReason, selector).toBe('forbidden');
      expect(await page().title(), selector).toBe('Round 18');
    }
  });

  test('reads a highlight as the word it is drawn in, and a page of the window height by all it shows', async () => {
    const page = () => session?.page as unknown as Page;
    const chip = await openAndAct({ kind: 'click', selector: '#chip18' }, ROUND18);
    expect(chip.ok, JSON.stringify([chip.stopReason, chip.detail])).toBe(true);
    expect(await page().title()).toBe('FILTERED');
    const card = await openAndAct({ kind: 'click', selector: '#card18' }, ROUND18);
    expect(card.ok, JSON.stringify([card.stopReason, card.detail])).toBe(true);
    const more = await openAndAct({ kind: 'click', selector: '#more18' }, ROUND18_TALL);
    expect(more.ok, JSON.stringify([more.stopReason, more.detail])).toBe(true);
    expect(await page().title()).toBe('MORE');
  });

  test('reads nothing of a page a dialog holds, and says so at once', async () => {
    const results = await openAndActAll([{ kind: 'click', selector: '#save18' }], ROUND18);
    expect(results[0].ok, JSON.stringify(results[0].detail)).toBe(true);
    const plan = {
      goal: 'save',
      steps: [
        { description: 'look', action: { kind: 'elements' as const } },
        { description: 'scroll', action: { kind: 'scroll' as const, value: 'down' } },
        { description: 'list tabs', action: { kind: 'tabs' as const } },
        { description: 'dismiss', action: { kind: 'dialog' as const, disposition: 'dismiss' } },
      ],
    };
    const started = Date.now();
    const ran: AoiBrowserDriveStepResult[] = [];
    for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
      ran.push(
        await executeAoiBrowserDriveStep({
          page: session?.page as unknown as AoiBrowserDriveActablePage,
          plan,
          stepIndex,
          allowlist: DENYLIST,
          approvalGate: async () => ({ approved: true }),
          now: Date.now(),
        }),
      );
    }
    expect(ran[0].detail).toContain('dialog_pending');
    expect(ran[1].detail).toContain('dialog_pending');
    // Tabs are listed all the same, the held tab without its title.
    expect(ran[2].ok).toBe(true);
    expect(ran[3].ok, JSON.stringify(ran[3].detail)).toBe(true);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test("leaves its own tab, not the operator's, when a frame's dialog in place of another cannot be answered", async () => {
    const aoi = session?.page as unknown as Page;
    const mail = await aoi.context().newPage();
    await mail.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Mail</title><textarea id="draft"></textarea>',
      }),
    );
    await mail.goto('https://mail.example/compose');
    await mail.fill('#draft', 'Dear team, half-written');
    try {
      const runAll = async (plan: {
        goal: string;
        steps: { description: string; action: AoiBrowserDriveActionRequest }[];
      }) => {
        const results: AoiBrowserDriveStepResult[] = [];
        for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
          results.push(
            await executeAoiBrowserDriveStep({
              page: aoi as unknown as AoiBrowserDriveActablePage,
              plan,
              stepIndex,
              allowlist: DENYLIST,
              approvalGate: async () => ({ approved: true }),
              now: Date.now(),
            }),
          );
        }
        return results;
      };
      const opened = await runAll({
        goal: 'help',
        steps: [
          { description: 'open help', action: { kind: 'navigate', url: ROUND18_FRAME } },
          { description: 'list tabs', action: { kind: 'tabs' } },
        ],
      });
      const mailTab = opened[1].tabs?.find((tab) => tab.url === 'https://mail.example/compose');
      expect(mailTab, JSON.stringify(opened.map((r) => [r.ok, r.detail, r.tabs]))).toBeDefined();
      // The drive goes on to the operator's tab; then the page's notice comes up
      // on Aoi's, and the widget's hello a moment later, in its place. (A page
      // stopped on its own alert passes no message on to a frame of another
      // site, so both are set off from here.)
      const switched = await runAll({
        goal: 'help',
        steps: [
          { description: 'to mail', action: { kind: 'tab', tabIndex: mailTab?.index ?? -1 } },
        ],
      });
      let chat: ReturnType<Page['frames']>[number] | undefined;
      await expect
        .poll(
          () => {
            chat = aoi.frames().find((frame) => frame.url().startsWith('https://chat.example/'));
            return Boolean(chat);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      await chat?.waitForFunction(() => 'sayHello' in window);
      await chat?.evaluate(() => (window as unknown as { sayHello(): void }).sayHello());
      await aoi
        .mainFrame()
        .evaluate(() => (window as unknown as { showNotice(): void }).showNotice());
      const waited = await runAll({
        goal: 'help',
        steps: [{ description: 'wait', action: { kind: 'wait', value: '3000' } }],
      });
      const results = [...switched, ...waited];
      expect(
        [...opened, ...results].map((r) => r.ok),
        JSON.stringify([...opened, ...results].map((r) => r.detail)),
      ).toEqual([true, true, true, true]);
      // The operator's tab keeps its page and its work; Aoi's own was left,
      // and it still answers: the browser did not go down.
      expect(mail.url()).toBe('https://mail.example/compose');
      expect(await mail.inputValue('#draft')).toBe('Dear team, half-written');
      await expect.poll(() => aoi.mainFrame().url(), { timeout: 15_000 }).toBe('about:blank');
      expect(await aoi.mainFrame().evaluate(() => 1 + 1)).toBe(2);
      expect(aoi.context().browser()?.isConnected() ?? true).toBe(true);
    } finally {
      await mail.close();
    }
  });

  test('leaves a page a frame on it asks to stay on', async () => {
    const aoi = session?.page as unknown as Page;
    const opened = await openAndActAll([], ROUND18_STAY);
    expect(opened).toEqual([]);
    // A comment box someone clicked into: the frame has had a click.
    await aoi.frameLocator('#comments18').locator('#comment').click();
    const plan = {
      goal: 'go on',
      steps: [{ description: 'go on', action: { kind: 'navigate' as const, url: SHOP } }],
    };
    const result = await executeAoiBrowserDriveStep({
      page: aoi as unknown as AoiBrowserDriveActablePage,
      plan,
      stepIndex: 0,
      allowlist: DENYLIST,
      approvalGate: async () => ({ approved: true }),
      now: Date.now(),
    });
    expect(result.ok, JSON.stringify([result.stopReason, result.detail])).toBe(true);
    expect(aoi.mainFrame().url()).toBe(SHOP);
  });

  test('clicks a card scrolled out of a carousel, and a field deep in a page, as it would one in view', async () => {
    const page = () => session?.page as unknown as Page;
    for (const selector of ['#cart19-5', '#cart19-1', '#co19']) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND19);
      expect(result.ok, `${selector} ${JSON.stringify([result.stopReason, result.detail])}`).toBe(
        true,
      );
    }
    expect(await page().title()).toBe('Round 19');
  });

  test('reads a closed pay box deep in a page, and a pay box whose words CSS sets apart', async () => {
    const page = () => session?.page as unknown as Page;
    for (const selector of ['#det19', '#det19b']) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND19);
      expect(result.stopReason, selector).toBe('forbidden');
      expect(await page().title(), selector).toBe('Round 19');
    }
  });

  test('refuses a buy row whose hidden note no scrolling reaches, and reads no hidden submenu', async () => {
    const page = () => session?.page as unknown as Page;
    const row = await openAndAct({ kind: 'click', selector: '#name20' }, ROUND20);
    expect(row.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Round 20');
    const shop = await openAndAct({ kind: 'click', selector: '#shop20' }, ROUND20);
    expect(shop.ok, JSON.stringify([shop.stopReason, shop.detail])).toBe(true);
    expect(page().url()).toBe(`${ROUND20}#shop`);
  });

  test('reads a highlighted result, a padded highlight and a wordmark as the words they draw', async () => {
    const page = () => session?.page as unknown as Page;
    for (const [selector, title] of [
      ['#result20', 'METHODS'],
      ['#share20', 'SHARED'],
      ['#paypal20', 'LOGIN'],
    ]) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND20);
      expect(result.ok, `${selector} ${JSON.stringify([result.stopReason, result.detail])}`).toBe(
        true,
      );
      expect(await page().title(), selector).toBe(title);
    }
  });

  test('does not accept a Korean confirm that pays on OK and says what its Cancel does', async () => {
    const page = () => session?.page as unknown as Page;
    const [click, accept] = await openAndActAll(
      [
        { kind: 'click', selector: '#next20' },
        { kind: 'dialog', disposition: 'accept' } as AoiBrowserDriveActionRequest,
      ],
      ROUND20,
    );
    expect(click.ok).toBe(true);
    expect(accept.stopReason).toBe('forbidden');
    await (session?.page as unknown as { answerDialog(d: string): Promise<string> }).answerDialog(
      'dismiss',
    );
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('NOTPAID');
  });

  test('reads a pay row a card hides past, a closed card clips, or a hidden section pads', async () => {
    const page = () => session?.page as unknown as Page;
    for (const selector of ['#clear21', '#closed21', '#chip21', '#ds21 button', '#found21']) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND21);
      expect(result.stopReason, selector).toBe('forbidden');
      expect(await page().title(), selector).toBe('Round 21');
    }
  });

  test('adds the last card of a zoomed carousel to the cart, as it would one in view', async () => {
    const page = () => session?.page as unknown as Page;
    const result = await openAndAct({ kind: 'click', selector: '#add21-5' }, ROUND21);
    expect(result.ok, JSON.stringify([result.stopReason, result.detail])).toBe(true);
    expect(await page().title()).toBe('ADDED5');
  });

  test('does not accept a confirm that tells a stop and then the amount due', async () => {
    const page = () => session?.page as unknown as Page;
    const [click, accept] = await openAndActAll(
      [
        { kind: 'click', selector: '#end21' },
        { kind: 'dialog', disposition: 'accept' } as AoiBrowserDriveActionRequest,
      ],
      ROUND21,
    );
    expect(click.ok).toBe(true);
    expect(accept.stopReason).toBe('forbidden');
    await (session?.page as unknown as { answerDialog(d: string): Promise<string> }).answerDialog(
      'dismiss',
    );
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('NOTPAID');
  });

  test('reads a price chip beside its pay word, and a fixed sheet by what the window shows', async () => {
    const page = () => session?.page as unknown as Page;
    for (const selector of ['#chf22', '#sheet22']) {
      const result = await openAndAct({ kind: 'click', selector }, ROUND22);
      expect(result.stopReason, selector).toBe('forbidden');
      expect(await page().title(), selector).toBe('Round 22');
    }
  });

  test('does not accept a confirm whose OK places the order, or that asks for a fee as it stops a plan', async () => {
    const page = () => session?.page as unknown as Page;
    for (const selector of ['#ko22', '#fee22']) {
      const [click, accept] = await openAndActAll(
        [
          { kind: 'click', selector },
          { kind: 'dialog', disposition: 'accept' } as AoiBrowserDriveActionRequest,
        ],
        ROUND22,
      );
      expect(click.ok, selector).toBe(true);
      expect(accept.stopReason, selector).toBe('forbidden');
      await (session?.page as unknown as { answerDialog(d: string): Promise<string> }).answerDialog(
        'dismiss',
      );
      await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('NOTPAID');
    }
  });

  test('measures a card the page defines while the click waits for approval, as it is then', async () => {
    const page = () => session?.page as unknown as Page;
    // Asked about, the row is long and says nothing; by the time the click is
    // approved, the closed card clips it to its pay words.
    const plan = {
      goal: 'shop',
      steps: [
        { description: 'open the shop', action: { kind: 'navigate' as const, url: ROUND23 } },
        { description: 'details', action: { kind: 'click' as const, selector: '#late23' } },
      ],
    };
    const results: AoiBrowserDriveStepResult[] = [];
    for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
      results.push(
        await executeAoiBrowserDriveStep({
          page: session?.page as unknown as AoiBrowserDriveActablePage,
          plan,
          stepIndex,
          allowlist: DENYLIST,
          approvalGate: async () => {
            if (stepIndex === 1) {
              await page().evaluate(() =>
                (window as unknown as { defineCard(): void }).defineCard(),
              );
            }
            return { approved: true };
          },
          now: Date.now(),
        }),
      );
    }
    expect(results[0].ok).toBe(true);
    expect(results[1].stopReason, JSON.stringify([results[1].detail])).toBe('forbidden');
    expect(await page().title()).toBe('Round 23');
  });

  test('does not order again, or accept a kept fee or a total a discount was applied to', async () => {
    const page = () => session?.page as unknown as Page;
    const repeat = await openAndAct({ kind: 'click', selector: '#repeat23' }, ROUND23);
    expect(repeat.stopReason).toBe('forbidden');
    expect(await page().title()).toBe('Round 23');
    for (const selector of ['#waive23', '#apply23', '#ko23']) {
      const [click, accept] = await openAndActAll(
        [
          { kind: 'click', selector },
          { kind: 'dialog', disposition: 'accept' } as AoiBrowserDriveActionRequest,
        ],
        ROUND23,
      );
      expect(click.ok, selector).toBe(true);
      expect(accept.stopReason, selector).toBe('forbidden');
      await (session?.page as unknown as { answerDialog(d: string): Promise<string> }).answerDialog(
        'dismiss',
      );
      await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('NOTPAID');
    }
  });

  test('accepts a Korean return that only says what it will refund', async () => {
    const page = () => session?.page as unknown as Page;
    const [click, accept] = await openAndActAll(
      [
        { kind: 'click', selector: '#refund23' },
        { kind: 'dialog', disposition: 'accept' } as AoiBrowserDriveActionRequest,
      ],
      ROUND23,
    );
    expect(click.ok).toBe(true);
    expect(accept.ok, JSON.stringify([accept.stopReason, accept.detail])).toBe(true);
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('RETURNED');
  });

  test('clicks a player from another site without waiting on a busy frame before it', async () => {
    const page = () => session?.page as unknown as Page;
    const result = await openAndAct({ kind: 'click', selector: '#watch-player' }, WATCH);
    expect(result.ok, JSON.stringify([result.stopReason, result.detail])).toBe(true);
    await expect.poll(() => page().title(), { timeout: 5_000 }).toBe('PLAYED');
  });

  test('treats a redirect onto a denied site during the wait as drift', async () => {
    const result = await openAndAct({ kind: 'click', selector: '#leave' });

    expect(result.ok).toBe(false);
    // The click ran; the page left afterwards. Contained, and not to repeat.
    expect(result.stopReason).toBe('drift_after_act');
    expect(result.verdict).toMatchObject({ effect: 'unverifiable', code: 'drift_after_act' });
    expect(result.afterAct).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('Enter your password');
    // Where it went is kept to the origin; the path of a denied page is not.
    expect(result.finalUrl).toBe('https://evil.example');
    // Contained: the tab no longer shows the denied page.
    expect((session?.page as unknown as Page).url()).toBe('about:blank');
  });
});
