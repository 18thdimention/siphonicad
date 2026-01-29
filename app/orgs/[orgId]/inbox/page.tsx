import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import Header from "@/components/header"

export default function Inbox() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <Header />
      </SidebarInset>
    </SidebarProvider>
  )
}