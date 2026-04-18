import { ReactNode, useEffect, useRef, useState, memo } from "react";
import "../styles/Sidebar.css";

interface SidebarProps {
  children: ReactNode;
  title?: string;
  width?: number;
}

const Sidebar = memo(({ children, title = "Menu", width = 250 }: SidebarProps) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [prevCollapsedState, setPrevCollapsedState] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const toggleBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-expanded-width", `${width}px`);

    const rootContainer = document.querySelector(".root-container");
    if (rootContainer) {
      if (isCollapsed) {
        rootContainer.classList.add("sidebar-collapsed");
      } else {
        rootContainer.classList.add("sidebar-expanded");
      }
    }
  }, [width, isCollapsed]);

  useEffect(() => {
    setPrevCollapsedState(isCollapsed);

    if (isCollapsed !== prevCollapsedState && toggleBtnRef.current) {
      toggleBtnRef.current.focus();
    }

    const rootContainer = document.querySelector(".root-container");
    if (rootContainer) {
      if (isCollapsed) {
        rootContainer.classList.remove("sidebar-expanded");
        rootContainer.classList.add("sidebar-collapsed");
      } else {
        rootContainer.classList.add("sidebar-expanded");
        rootContainer.classList.remove("sidebar-collapsed");
      }
    }

    const event = new Event("resize");
    window.dispatchEvent(event);
  }, [isCollapsed]);

  useEffect(() => {
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (
        event.target !== sidebarRef.current ||
        (event.propertyName !== "width" && event.propertyName !== "min-width")
      ) {
        return;
      }

      const resizeEvent = new Event("resize");
      window.dispatchEvent(resizeEvent);
    };

    const sidebarEl = sidebarRef.current;
    if (sidebarEl) {
      sidebarEl.addEventListener("transitionend", handleTransitionEnd);
    }

    return () => {
      if (sidebarEl) {
        sidebarEl.removeEventListener("transitionend", handleTransitionEnd);
      }
    };
  }, []);

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  return (
    <div
      ref={sidebarRef}
      className={`sidebar ${isCollapsed ? "collapsed" : "expanded"}`}
      style={{
        width: isCollapsed ? "var(--sidebar-collapsed-width)" : "var(--sidebar-expanded-width)",
        minWidth: isCollapsed ? "var(--sidebar-collapsed-width)" : "var(--sidebar-expanded-width)",
      }}
      data-state={isCollapsed ? "collapsed" : "expanded"}
    >
      <div className="sidebar-header">
        <h3 className="sidebar-title">{title}</h3>
        <button
          ref={toggleBtnRef}
          className="sidebar-toggle"
          onClick={toggleCollapse}
          aria-label={isCollapsed ? "open sidebar" : "close sidebar"}
          title={isCollapsed ? "open sidebar" : "close sidebar"}
        >
          {isCollapsed ? "→" : "←"}
        </button>
      </div>
      <div className="sidebar-content">{children}</div>
    </div>
  );
});

Sidebar.displayName = "Sidebar";

export { Sidebar };
export default Sidebar;
