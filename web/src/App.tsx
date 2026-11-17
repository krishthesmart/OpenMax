import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Settings } from "./pages/Settings";
import { Chat } from "./pages/Chat";
import { Research } from "./pages/Research";
import { Studio } from "./pages/Studio";
import { Code } from "./pages/Code";
import { Gems } from "./pages/Gems";
import { RouterPage } from "./pages/Router";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/chat/:id" element={<Chat />} />
        <Route path="/research" element={<Research />} />
        <Route path="/studio" element={<Studio />} />
        <Route path="/code" element={<Code />} />
        <Route path="/gems" element={<Gems />} />
        <Route path="/router" element={<RouterPage />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
