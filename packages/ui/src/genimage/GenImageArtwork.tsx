import { useEffect, useRef, useState } from "react";
import type { GenImageNode } from "./contract.js";
import type { LoadThumbnail } from "./useGenImageLocal.js";

export type CanvasNode = GenImageNode;

function Thumbnail({
  id,
  className,
  load,
}: {
  id: string;
  className: string;
  load?: LoadThumbnail;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    const element = host.current;
    if (!element || !load) return;
    const controller = new AbortController();
    const request = () => {
      void load(id, controller.signal).then((src) => {
        if (!controller.signal.aborted) setUrl(src);
      });
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            if (!entry?.isIntersecting) return;
            observer?.disconnect();
            request();
          });
    if (observer) observer.observe(element);
    else request();
    return () => {
      observer?.disconnect();
      controller.abort();
    };
  }, [id, load]);

  return (
    <span ref={host} className={`${className} gi-thumbnail`} aria-hidden="true">
      {url ? <img src={url} alt="" decoding="async" draggable={false} /> : null}
    </span>
  );
}

export function GenImageArtwork({
  node,
  className,
  loadThumbnail,
}: {
  node: CanvasNode;
  className: string;
  loadThumbnail?: LoadThumbnail;
}) {
  return <Thumbnail key={node.id} id={node.id} className={className} load={loadThumbnail} />;
}

export function nodeLabel(node: CanvasNode) {
  return node.id.slice(0, 8);
}
