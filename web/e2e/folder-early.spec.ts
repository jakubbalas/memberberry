import { expect, test } from "./fixtures.js";
import { folderServer, loginFolderServer } from "./folder-fixture.js";
import { activateFolderControl } from "./folder-actions.js";
test("early simple picker renders and navigates before creation controls are implemented",async({page},info)=>{
 const server=await folderServer(),mobile=info.project.name==="mobile";
 try{
  await loginFolderServer(page,server.origin);await page.getByRole("link",{name:"New vault",exact:true}).click();
  const act=async(name:string)=>activateFolderControl(page.getByRole("button",{name,exact:true}),mobile,!mobile);
  await act("Choose folder");const dialog=page.getByRole("dialog");
  await expect(dialog.getByRole("heading",{name:"Projects",exact:true})).toBeVisible();
  await expect(page.getByLabel("Server location",{exact:true})).toBeHidden();
  await expect(page.getByRole("button",{name:"Go to parent folder",exact:true})).toBeHidden();
  await expect(page.getByRole("button",{name:"Use this folder",exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"Add folder here",exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath("root.png")});
  await act("日本: 100%");await expect(dialog.getByRole("heading",{name:"日本: 100%",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Use this folder",exact:true})).toBeEnabled();
  await act("Go to parent folder");await expect(dialog.getByRole("heading",{name:"Projects",exact:true})).toBeVisible();
  await act("Empty");await expect(page.locator("#picker-message")).toHaveText("0 folders found");
  await page.screenshot({path:info.outputPath("empty.png")});await act("Cancel");
  await expect(page.getByRole("button",{name:"Choose folder",exact:true})).toBeFocused();
  if(mobile){await page.setViewportSize({width:320,height:915});await act("Choose folder");expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await page.screenshot({path:info.outputPath("320.png")});await act("Cancel");}
 }finally{await page.goto("about:blank");await server.stop();}
});
