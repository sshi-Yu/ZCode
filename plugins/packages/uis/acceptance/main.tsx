import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createHostThemeStore, ThemeProvider, useHostTheme, Button, Input, Label, Textarea, Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogClose } from "../src";
import "../src/styles.css";

const store = createHostThemeStore(document.documentElement.dataset.theme);
let mounts = 0;
function Scenario() {
  const snapshot = useHostTheme();
  const [draft, setDraft] = useState("");
  useEffect(() => { mounts++; }, []);
  const change = () => store.update({ theme: snapshot.theme === "dark" ? "light" : "dark", locale: snapshot.locale === "en-US" ? "zh-CN" : "en-US" });
  const invalid = () => store.update({ theme: "invalid", styles: { variables: { "--color-background-primary": "url(https://example.com/evil)", "--unknown": "red" } } });
  return <main className="min-h-screen bg-background text-foreground p-4 flex flex-col gap-4">
    <h1 className="text-ui-lg font-medium">Shared UI engineering scenario</h1>
    <p className="text-ui-sm text-foreground-subtle" data-testid="status">{snapshot.theme} · {snapshot.locale} · mounts {mounts || 1}</p>
    <span data-testid="dark-scope" className="opacity-100 dark:opacity-50 text-ui-sm">Scoped dark variant</span>
    <div className="flex flex-wrap gap-2">
      <Button onClick={change}>Change host theme / locale</Button>
      <Button variant="outline" onClick={invalid}>Send invalid context</Button>
      <Button variant="secondary" onClick={() => store.update({ styles: { variables: { "--color-background-primary": "#16334a", "--font-text-md-size": "16px" } }, safeAreaInsets: { top: 12 } })}>Host semantic update</Button>
    </div>
    <Label htmlFor="draft">Persistent draft</Label>
    <Input id="draft" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Draft survives host updates" />
    <Textarea aria-label="Notes" placeholder="Notes" />
    <p className="text-ui-base" data-testid="draft">Draft: {draft}</p>
    <Dialog><DialogTrigger asChild><Button variant="outline">Open themed dialog</Button></DialogTrigger>
      <DialogContent><DialogTitle>Host appearance in portal</DialogTitle><DialogDescription>Theme, locale and semantic variables come from the same store.</DialogDescription>
        <Button onClick={change}>Change host in dialog</Button><DialogClose asChild><Button variant="outline">Done</Button></DialogClose>
      </DialogContent>
    </Dialog>
  </main>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing acceptance root");
createRoot(root).render(<ThemeProvider store={store}><Scenario /></ThemeProvider>);
