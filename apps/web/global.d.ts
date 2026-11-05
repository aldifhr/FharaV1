declare module "*.css";

interface Window {
  moagentDesktop?: {
    selectFolder: () => Promise<string | null>;
  };
}
