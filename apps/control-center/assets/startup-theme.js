(() => {
  const requestedTheme = new URLSearchParams(window.location.search).get("theme");
  document.documentElement.dataset.theme = requestedTheme === "dark" ? "dark" : "light";
})();
