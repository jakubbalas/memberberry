/** Test-only jsdom platform shim; real modal focus/Escape is tested in the browser. */
export function installDialogShim():void {
  Object.defineProperties(HTMLDialogElement.prototype,{
    showModal:{configurable:true,value(this:HTMLDialogElement){this.open=true;}},
    close:{configurable:true,value(this:HTMLDialogElement){this.open=false;}},
  });
}
