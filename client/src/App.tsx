import { useEffect, useState } from 'react';
import Viewer from './viewer/Viewer';
import AdminApp from './admin/AdminApp';

/**
 * Two surfaces, one bundle: the viewer at /, the logistics panel at /admin.
 * Deliberately no router dependency — there are exactly two routes.
 *
 * `/s/:code` never reaches React: the server redeems it, sets the session
 * cookie and redirects to /, so a magic link works before the bundle has even
 * downloaded. If one does arrive here, the server is not running the current
 * build — send it back through the server rather than rendering a blank page.
 */
export default function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (path.startsWith('/admin')) return <AdminApp />;
  if (path.startsWith('/s/')) {
    window.location.replace(path);
    return null;
  }
  return <Viewer />;
}
