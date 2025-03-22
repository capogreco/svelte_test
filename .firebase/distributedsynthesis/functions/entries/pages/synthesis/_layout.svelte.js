import "clsx";
function _layout($$payload, $$props) {
  let { data, children } = $$props;
  children($$payload);
  $$payload.out += `<!---->`;
}
export {
  _layout as default
};
