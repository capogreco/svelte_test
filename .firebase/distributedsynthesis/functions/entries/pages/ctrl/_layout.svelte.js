import "clsx";
import { X as store_get, Y as slot, Z as unsubscribe_stores, V as pop, S as push } from "../../../chunks/index.js";
import { u as user } from "../../../chunks/firebase.js";
import "firebase/auth";
import "../../../chunks/client.js";
function AuthCheck($$payload, $$props) {
  push();
  var $$store_subs;
  if (store_get($$store_subs ??= {}, "$user", user)) {
    $$payload.out += "<!--[-->";
    $$payload.out += `<button class="absolute top-4 right-4 btn btn-primary">Sign out</button> `;
    if (store_get($$store_subs ??= {}, "$user", user).uid === `ap13XJUrp7duHAPYfubdKmgRZXd2`) {
      $$payload.out += "<!--[-->";
      $$payload.out += `<!---->`;
      slot($$payload, $$props, "default", {});
      $$payload.out += `<!---->`;
    } else {
      $$payload.out += "<!--[!-->";
      $$payload.out += `<h1 class="text-3xl font-bold underline">USER NOT AUTHORISED</h1>`;
    }
    $$payload.out += `<!--]-->`;
  } else {
    $$payload.out += "<!--[!-->";
    $$payload.out += `<button class="btn btn-primary">Sign in with Google</button>`;
  }
  $$payload.out += `<!--]-->`;
  if ($$store_subs) unsubscribe_stores($$store_subs);
  pop();
}
function _layout($$payload, $$props) {
  push();
  let { children } = $$props;
  $$payload.out += `<canvas id="cnv" style="position:absolute; z-index:-1"></canvas> <main class="flex flex-col items-center justify-center min-h-screen">`;
  AuthCheck($$payload, {
    children: ($$payload2) => {
      children($$payload2);
      $$payload2.out += `<!---->`;
    },
    $$slots: { default: true }
  });
  $$payload.out += `<!----></main>`;
  pop();
}
export {
  _layout as default
};
