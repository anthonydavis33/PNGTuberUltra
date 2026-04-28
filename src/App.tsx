import { Toolbar } from "./panels/Toolbar";
import { LayerTree } from "./panels/LayerTree";
import { Properties } from "./panels/Properties";
import { PixiCanvas } from "./canvas/PixiCanvas";
import "./App.css";

export default function App() {
  return (
    <div className="app">
      <Toolbar />
      <main className="editor">
        <LayerTree />
        <PixiCanvas />
        <Properties />
      </main>
    </div>
  );
}
