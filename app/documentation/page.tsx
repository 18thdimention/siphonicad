import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import Header from "@/components/header"
import { MarkdownDocument } from "./MarkdownDocument"

export default function Documentation() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <Header />
        <main className="p-6">
          <MarkdownDocument />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
