"use client";

import { useEffect, useState } from "react";
import { Home, Inbox, Search, Settings } from "lucide-react";
import { usePathname } from "next/navigation";
import Link from "next/link";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export function AppSidebar() {
  const pathname = usePathname();
  const [orgId, setOrgId] = useState<string | null>(null);

  useEffect(() => {
    // 1) Try to derive orgId from the current pathname
    // Pathname will be like /orgs/[orgId] or /orgs/[orgId]/inbox, etc.
    const orgMatch = pathname?.match(/^\/orgs\/([^/]+)/);

    if (orgMatch?.[1]) {
      const currentOrgId = orgMatch[1];
      setOrgId(currentOrgId);

      // Persist for routes that don't include the org segment (e.g. /documentation)
      if (typeof window !== "undefined") {
        window.localStorage.setItem("currentOrgId", currentOrgId);
      }

      return;
    }

    // 2) Fallback: use the last org the user visited, stored in localStorage
    if (typeof window !== "undefined") {
      const storedOrgId = window.localStorage.getItem("currentOrgId");
      if (storedOrgId) {
        setOrgId(storedOrgId);
      }
    }
  }, [pathname]);

  // Build menu items based on whether we know the current org
  const items = [
    {
      title: "Projects",
      url: orgId ? `/orgs/${orgId}` : "/projects",
      icon: Home,
    },
    {
      title: "Inbox",
      url: orgId ? `/orgs/${orgId}/inbox` : "/inbox",
      icon: Inbox,
    },
    {
      title: "Documentation",
      // Documentation itself is not org-scoped, but we still want
      // the sidebar (from there) to link back into the active org.
      url: "/documentation",
      icon: Search,
    },
    {
      title: "Settings",
      url: orgId ? `/orgs/${orgId}/settings` : "/settings",
      icon: Settings,
    },
  ];

  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Directory</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <Link href={item.url}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
