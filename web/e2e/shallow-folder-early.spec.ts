import { expect, test } from "./fixtures.js";
import { folderServer, loginFolderServer } from "./folder-fixture.js";
import { activateFolderControl } from "./folder-actions.js";
test("early in-vault shallow folder renders immediate filename rows and navigates before creation lifecycle",async({page},info)=>{
 const server=await folderServer(),mobile=info.project.name==="mobile";
 try{
  await loginFolderServer(page,server.origin);await page.goto(`${server.origin}/vaults/add`);
  const act=async(name:string)=>activateFolderControl(page.getByRole("button",{name,exact:true}),mobile,!mobile);
  await page.getByLabel("Vault label",{exact:true}).fill("Early project");await act("Choose folder");await act("日本: 100%");await act("Use this folder");await act("Add vault");
  await expect(page.getByRole("heading",{name:"Vault registered",exact:true})).toBeVisible();await page.getByRole("link",{name:"Open vault",exact:true}).click();
  const show=page.getByRole("button",{name:"Show Navigation",exact:true});if(mobile){await expect(show).toBeVisible();await show.tap();}
  await page.getByRole("button",{name:"Folder actions for build",exact:true}).click();await page.getByRole("menuitem",{name:"Open in main panel",exact:true}).click();
  const folder=page.locator(".folder-contents");await expect(folder.getByRole("heading",{name:"build",exact:true})).toBeVisible();
  await expect(folder.getByRole("button",{name:"Generated.md",exact:true})).toBeVisible();await expect(folder).toContainText("0 folders found");
  await page.screenshot({path:info.outputPath("shallow-build.png")});
  await folder.getByRole("button",{name:"Go to parent folder",exact:true}).click();await expect(folder.getByRole("button",{name:"README.md",exact:true})).toBeVisible();
  await expect(folder.getByRole("button",{name:"Generated.md",exact:true})).toHaveCount(0);
  await folder.getByRole("button",{name:"Open folder node_modules",exact:true}).click();await expect(folder.getByRole("button",{name:"Open folder pkg",exact:true})).toBeVisible();
  await folder.getByRole("button",{name:"Open folder pkg",exact:true}).click();await expect(folder.getByRole("button",{name:"Guide.md",exact:true})).toBeVisible();
  if(mobile)await page.setViewportSize({width:320,height:915});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.screenshot({path:info.outputPath("shallow-nested.png")});
 }finally{try{if(!page.isClosed())await page.goto("about:blank");}finally{await server.stop();}}
});
