export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["favicon.png"]),
	mimeTypes: {".png":"image/png"},
	_: {
		client: {start:"_app/immutable/entry/start.BZ6mXBqm.js",app:"_app/immutable/entry/app.DxRQM-mK.js",imports:["_app/immutable/entry/start.BZ6mXBqm.js","_app/immutable/chunks/CcBnKJWM.js","_app/immutable/chunks/DUB8jJgW.js","_app/immutable/chunks/Cu-gZDEy.js","_app/immutable/entry/app.DxRQM-mK.js","_app/immutable/chunks/DUB8jJgW.js","_app/immutable/chunks/XjDYXuum.js","_app/immutable/chunks/C9_AxQy4.js","_app/immutable/chunks/Cob43IS2.js","_app/immutable/chunks/CWj6FrbW.js","_app/immutable/chunks/DyWJfrTX.js","_app/immutable/chunks/Bww0RyzZ.js","_app/immutable/chunks/Cu-gZDEy.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js')),
			__memo(() => import('./nodes/1.js')),
			__memo(() => import('./nodes/2.js')),
			__memo(() => import('./nodes/3.js')),
			__memo(() => import('./nodes/4.js')),
			__memo(() => import('./nodes/5.js')),
			__memo(() => import('./nodes/6.js')),
			__memo(() => import('./nodes/7.js')),
			__memo(() => import('./nodes/8.js')),
			__memo(() => import('./nodes/9.js'))
		],
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 4 },
				endpoint: null
			},
			{
				id: "/ctrl",
				pattern: /^\/ctrl\/?$/,
				params: [],
				page: { layouts: [0,2,], errors: [1,,], leaf: 5 },
				endpoint: null
			},
			{
				id: "/ctrl/active",
				pattern: /^\/ctrl\/active\/?$/,
				params: [],
				page: { layouts: [0,2,], errors: [1,,], leaf: 6 },
				endpoint: null
			},
			{
				id: "/synthesis",
				pattern: /^\/synthesis\/?$/,
				params: [],
				page: { layouts: [0,3,], errors: [1,,], leaf: 7 },
				endpoint: null
			},
			{
				id: "/synthesis/active",
				pattern: /^\/synthesis\/active\/?$/,
				params: [],
				page: { layouts: [0,3,], errors: [1,,], leaf: 8 },
				endpoint: null
			},
			{
				id: "/synthesis/connecting",
				pattern: /^\/synthesis\/connecting\/?$/,
				params: [],
				page: { layouts: [0,3,], errors: [1,,], leaf: 9 },
				endpoint: null
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();
