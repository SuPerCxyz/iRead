import { Route, Routes } from "react-router-dom"

import { AppShell } from "./app-shell"
import { AuthGate } from "@/features/auth/auth-gate"
import { BookPage } from "@/pages/book-page"
import { HomePage } from "@/pages/home-page"
import { LibraryPage } from "@/pages/library-page"
import { NotFoundPage } from "@/pages/not-found-page"
import { ReaderPage } from "@/pages/reader-page"
import { SettingsPage } from "@/pages/settings-page"

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AuthGate />}>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="books/:id" element={<BookPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        <Route path="read/:id" element={<ReaderPage />} />
      </Route>
    </Routes>
  )
}
