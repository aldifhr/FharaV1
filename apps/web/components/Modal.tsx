"use client";

import { ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { Card, CardContent } from "./ui/card";

export default function Modal({
  title,
  children,
  onClose,
  maxWidth = "max-w-md",
  fullScreen = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  maxWidth?: string;
  fullScreen?: boolean;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const header = (
    <div className="flex items-center justify-between gap-4">
      <h2 className="font-medium">{title}</h2>
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-800 dark:hover:text-white"
        aria-label="Close"
      >
        <X size={17} />
      </button>
    </div>
  );

  if (!mounted) return null;

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16 }}
      className={
        fullScreen
          ? "fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          : "fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      }
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className={
          fullScreen
            ? "w-full max-w-3xl"
            : `w-full ${maxWidth}`
        }
        onMouseDown={(event) => event.stopPropagation()}
      >
        <Card className="overflow-hidden border-[#ebe9f0] bg-white shadow-2xl dark:border-gray-800 dark:bg-gray-900">
          <CardContent className="p-5">
            {header}
            <div className={fullScreen ? "mt-4" : ""}>{children}</div>
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>,
    document.body
  );
}
