"use client";

import React, { useState, useRef } from "react";
import {
  motion,
  useTransform,
  AnimatePresence,
  useMotionValue,
  useSpring,
} from "motion/react";
import { AvatartionAvatarView, type AvatartionAvatar } from "./avatartion";

export const AnimatedTooltip = ({
  items,
}: {
  items: {
    id: number | string;
    name: string;
    designation: string;
    avatar?: AvatartionAvatar;
    image?: string;
    size?: number;
  }[];
}) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | string | null>(null);
  const springConfig = { stiffness: 100, damping: 15 };
  const x = useMotionValue(0);
  const animationFrameRef = useRef<number | null>(null);

  const rotate = useSpring(
    useTransform(x, [-100, 100], [-45, 45]),
    springConfig,
  );
  const translateX = useSpring(
    useTransform(x, [-100, 100], [-50, 50]),
    springConfig,
  );

  const handleMouseMove = (event: any) => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    animationFrameRef.current = requestAnimationFrame(() => {
      const halfWidth = event.target.offsetWidth / 2;
      x.set(event.nativeEvent.offsetX - halfWidth);
    });
  };

  return (
    <div className="flex items-center">
      {items.map((item) => (
        <div
          className="group relative z-50 flex flex-col items-center"
          key={item.name}
          onMouseEnter={() => setHoveredIndex(item.id)}
          onMouseLeave={() => setHoveredIndex(null)}
        >
          <AnimatePresence>
            {hoveredIndex === item.id && (
              <motion.div
                initial={{ opacity: 0, y: 20, scale: 0.6 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  scale: 1,
                  transition: {
                    type: "spring",
                    stiffness: 260,
                    damping: 10,
                  },
                }}
                exit={{ opacity: 0, y: 20, scale: 0.6 }}
                style={{
                  translateX: translateX,
                  rotate: rotate,
                  whiteSpace: "nowrap",
                }}
                className="absolute -top-16 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center justify-center rounded-md bg-black px-4 py-2 text-xs shadow-xl"
              >
                <div className="absolute inset-x-10 -bottom-px z-30 h-px w-[20%] bg-gradient-to-r from-transparent via-emerald-500 to-transparent" />
                <div className="absolute -bottom-px left-10 z-30 h-px w-[40%] bg-gradient-to-r from-transparent via-sky-500 to-transparent" />
                <div className="relative z-30 text-base font-bold text-white">{item.name}</div>
                <div className="text-xs text-white">{item.designation}</div>
              </motion.div>
            )}
          </AnimatePresence>
          {item.avatar ? (
            <div
              onMouseMove={handleMouseMove}
              className="relative !m-0 h-14 w-14 rounded-full border-2 border-white p-0 transition duration-500 group-hover:z-30 group-hover:scale-105"
              style={item.size ? { width: item.size, height: item.size } : undefined}
            >
              <AvatartionAvatarView avatar={item.avatar} className="h-full w-full" />
            </div>
          ) : item.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              onMouseMove={handleMouseMove}
              height={item.size ?? 100}
              width={item.size ?? 100}
              src={item.image}
              alt={item.name}
              className="relative !m-0 h-14 w-14 rounded-full border-2 border-white object-cover object-top !p-0 transition duration-500 group-hover:z-30 group-hover:scale-105"
              style={item.size ? { width: item.size, height: item.size } : undefined}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
};
