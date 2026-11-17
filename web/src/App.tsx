import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Settings } from "./pages/Settings";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/settings" replace />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
