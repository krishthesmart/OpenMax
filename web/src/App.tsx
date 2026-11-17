import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Settings } from "./pages/Settings";
import { RouterPage } from "./pages/Router";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/settings" replace />} />
        <Route path="/router" element={<RouterPage />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
