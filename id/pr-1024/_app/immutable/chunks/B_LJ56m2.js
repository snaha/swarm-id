import{a as e,i as t,n,o as r,r as i,t as a}from"./DuZ9DLP4.js";var o=Object.defineProperty,s=Object.getOwnPropertyDescriptor,c=(e,t,n,r)=>{for(var i=r>1?void 0:r?s(t,n):t,a=e.length-1,c;a>=0;a--)(c=e[a])&&(i=(r?c(t,n,i):c(i))||i);return r&&i&&o(t,n,i),i},l=class extends i{constructor(){super(...arguments),this.size=`1em`,this.weight=`regular`,this.color=`currentColor`,this.mirrored=!1}render(){return t`<svg
      xmlns="http://www.w3.org/2000/svg"
      width="${this.size}"
      height="${this.size}"
      fill="${this.color}"
      viewBox="0 0 256 256"
      transform=${this.mirrored?`scale(-1, 1)`:null}
    >
      ${l.weightsMap.get(this.weight??`regular`)}
    </svg>`}};l.weightsMap=new Map([[`thin`,e`<path d="M210.83,162.83a4,4,0,0,1-5.66,0L128,85.66,50.83,162.83a4,4,0,0,1-5.66-5.66l80-80a4,4,0,0,1,5.66,0l80,80A4,4,0,0,1,210.83,162.83Z"/>`],[`light`,e`<path d="M212.24,164.24a6,6,0,0,1-8.48,0L128,88.49,52.24,164.24a6,6,0,0,1-8.48-8.48l80-80a6,6,0,0,1,8.48,0l80,80A6,6,0,0,1,212.24,164.24Z"/>`],[`regular`,e`<path d="M213.66,165.66a8,8,0,0,1-11.32,0L128,91.31,53.66,165.66a8,8,0,0,1-11.32-11.32l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,213.66,165.66Z"/>`],[`bold`,e`<path d="M216.49,168.49a12,12,0,0,1-17,0L128,97,56.49,168.49a12,12,0,0,1-17-17l80-80a12,12,0,0,1,17,0l80,80A12,12,0,0,1,216.49,168.49Z"/>`],[`fill`,e`<path d="M215.39,163.06A8,8,0,0,1,208,168H48a8,8,0,0,1-5.66-13.66l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,215.39,163.06Z"/>`],[`duotone`,e`<path d="M208,160H48l80-80Z" opacity="0.2"/><path d="M213.66,154.34l-80-80a8,8,0,0,0-11.32,0l-80,80A8,8,0,0,0,48,168H208a8,8,0,0,0,5.66-13.66ZM67.31,152,128,91.31,188.69,152Z"/>`]]),l.styles=r`
    :host {
      display: contents;
    }
  `,c([a({type:String,reflect:!0})],l.prototype,`size`,2),c([a({type:String,reflect:!0})],l.prototype,`weight`,2),c([a({type:String,reflect:!0})],l.prototype,`color`,2),c([a({type:Boolean,reflect:!0})],l.prototype,`mirrored`,2),l=c([n(`ph-caret-up`)],l);export{l as PhCaretUp};