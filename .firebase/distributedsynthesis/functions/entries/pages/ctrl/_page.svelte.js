import { X as store_get, Z as unsubscribe_stores, V as pop, S as push } from "../../../chunks/index.js";
import { u as user } from "../../../chunks/firebase.js";
import "../../../chunks/client.js";
import { e as escape_html } from "../../../chunks/escaping.js";
function _page($$payload, $$props) {
  push();
  var $$store_subs;
  $$payload.out += `<h1>HELLO ${escape_html(store_get($$store_subs ??= {}, "$user", user)?.displayName?.toUpperCase())}</h1>`;
  if ($$store_subs) unsubscribe_stores($$store_subs);
  pop();
}
export {
  _page as default
};
