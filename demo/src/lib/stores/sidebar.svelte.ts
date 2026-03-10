let mobileOpen = $state(false)

export const sidebarStore = {
  get mobileOpen() {
    return mobileOpen
  },
  openMobile() {
    mobileOpen = true
  },
  closeMobile() {
    mobileOpen = false
  },
  toggleMobile() {
    mobileOpen = !mobileOpen
  },
}
