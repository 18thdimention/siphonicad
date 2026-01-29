import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
} from "@/components/ui/menubar"


export default function CanvasMenubar() {
  return (
    <Menubar>
      <MenubarMenu>
        <MenubarTrigger>File</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>Save</MenubarItem>
          <MenubarSeparator />
          <MenubarItem>Share</MenubarItem>
          <MenubarSeparator />
          <MenubarItem>Export</MenubarItem>
          <MenubarSeparator />
          <MenubarItem>Exist</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
      <MenubarMenu>
        <MenubarTrigger>Edit</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>Set Endpoint</MenubarItem>
          <MenubarSeparator />
          <MenubarItem>Set Y-valve</MenubarItem>
          <MenubarSeparator />
          <MenubarItem>Set Reducer</MenubarItem>
          <MenubarSeparator />
          <MenubarItem>Set Points</MenubarItem>
        </MenubarContent>
       </MenubarMenu>
    </Menubar>
  )
}