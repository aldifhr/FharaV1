declare module "*.css";

interface Window {
  fharaDesktop?: {
    selectFolder: () => Promise<string | null>;
  };
}
