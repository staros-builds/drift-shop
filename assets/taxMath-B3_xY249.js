import{r as s}from"./index-BtsU_wES.js";/**
 * @license lucide-react v0.454.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const p=e=>e.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase(),m=(...e)=>e.filter((a,t,n)=>!!a&&a.trim()!==""&&n.indexOf(a)===t).join(" ").trim();/**
 * @license lucide-react v0.454.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */var h={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};/**
 * @license lucide-react v0.454.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const b=s.forwardRef(({color:e="currentColor",size:a=24,strokeWidth:t=2,absoluteStrokeWidth:n,className:r="",children:o,iconNode:c,...l},u)=>s.createElement("svg",{ref:u,...h,width:a,height:a,stroke:e,strokeWidth:n?Number(t)*24/Number(a):t,className:m("lucide",r),...l},[...c.map(([d,x])=>s.createElement(d,x)),...Array.isArray(o)?o:[o]]));/**
 * @license lucide-react v0.454.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const i=(e,a)=>{const t=s.forwardRef(({className:n,...r},o)=>s.createElement(b,{ref:o,iconNode:a,className:m(`lucide-${p(e)}`,n),...r}));return t.displayName=`${e}`,t};/**
 * @license lucide-react v0.454.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const T=i("Mail",[["rect",{width:"20",height:"16",x:"2",y:"4",rx:"2",key:"18n3k1"}],["path",{d:"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",key:"1ocrg3"}]]);/**
 * @license lucide-react v0.454.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const k=i("ShoppingBag",[["path",{d:"M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z",key:"hou9p0"}],["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M16 10a4 4 0 0 1-8 0",key:"1ltviw"}]]);/**
 * @license lucide-react v0.454.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const w=i("Star",[["path",{d:"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",key:"r04s7s"}]]);function S(e,a){const t=e.taxRates&&e.taxRates.length>0?e.taxRates:[{name:"Tax",rate:Number(e.taxRate)||0}];let n=0;return t.filter(r=>Number(r.rate)>0).map(r=>{const o=Number(r.rate),c=r.compound?a+n:a,l=Math.round(c*o/100);n+=l;const u={name:r.name||"Tax",rate:o,cents:l};return r.compound&&(u.compound=!0),u})}const y=[{id:"custom",label:"Custom rates…",labelFr:"Taux personnalisés…",rates:null},{id:"none",label:"No tax",labelFr:"Aucune taxe",rates:[]},{id:"single",label:"Single tax",labelFr:"Taxe unique",rates:[{name:"Tax 1",nameFr:"Taxe 1",rate:0}]},{id:"stacked2",label:"Two stacked taxes (each on the pre-tax subtotal)",labelFr:"Deux taxes cumulées (chacune sur le sous-total avant taxes)",rates:[{name:"Tax 1",nameFr:"Taxe 1",rate:0},{name:"Tax 2",nameFr:"Taxe 2",rate:0}]}],g=[],F=e=>{const a=JSON.stringify((e||[]).filter(t=>Number(t.rate)>0).map(t=>[Number(t.rate),t.compound===!0]));return g.find(t=>JSON.stringify(t.oldSig)===a)||null},N=(e,a)=>a==="fr"&&e.labelFr||e.label,E=(e,a)=>a==="fr"&&e.nameFr||e.name;export{T as M,w as S,y as T,k as a,E as b,i as c,F as o,N as p,S as t};
