import "clsx";
import { V as pop, S as push } from "../../../../chunks/index.js";
import "../../../../chunks/firebase.js";
import "../../../../chunks/client.js";
function _page($$payload, $$props) {
  push();
  $$payload.out += `<h1 class="text-3xl font-bold underline">ACTIVE</h1>`;
  pop();
}
export {
  _page as default
};
