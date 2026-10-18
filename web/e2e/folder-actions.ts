import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
/** Exercises the shipped control via keyboard on desktop or a real mobile tap. */
export async function activateFolderControl(control:Locator,mobile:boolean,keyboard=false):Promise<void>{
 if(keyboard){await expect(control).toBeEnabled();await control.focus();await control.press("Enter");}else if(mobile)await control.tap();else await control.click();
}
/** Chooses a location-relative directory through the real modal, not a fixture state shortcut. */
export async function chooseVaultFolder(page:Page,mode:"existing"|"new",mobile:boolean,path?:string):Promise<void>{
 if(mode!=="existing")throw new Error("Creation requires explicit createVaultFolder with a literal name");
 await activateFolderControl(page.getByRole("button",{name:"Choose folder",exact:true}),mobile);
 if(path!==undefined)await activateFolderControl(page.getByRole("button",{name:path,exact:true}),mobile);
 await activateFolderControl(page.getByRole("button",{name:"Use this folder",exact:true}),mobile);
}

/** Explicit mkdir, then verified navigation; it does not register or select the child. */
export async function createVaultFolder(page:Page,mobile:boolean,directory:string):Promise<void>{
 await activateFolderControl(page.getByRole("button",{name:"Add folder here",exact:true}),mobile,!mobile);
 await page.getByLabel("Folder name",{exact:true}).fill(directory);
 await activateFolderControl(page.getByRole("button",{name:"Create",exact:true}),mobile,!mobile);
 await expect(page.locator("#picker-heading")).toHaveText(directory);
 await expect(page.getByRole("button",{name:"Use this folder",exact:true})).toBeEnabled();
}
