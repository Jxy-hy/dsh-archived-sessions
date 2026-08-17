/** CSS Modules declaration for the plugin's client bundle (mirrors the repo convention). */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
