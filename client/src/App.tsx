import { useEffect, useState } from 'react';
import Viewer from './viewer/Viewer';
import AdminApp from './admin/AdminApp';

/**
 * Two surfaces, one bundle: the shared-link viewer at /, the logistics panel at
 * /admin. Deliberately no router dependency — there are exactly two routes.
 */
export default function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (path.startsWith('/admin')) return <AdminApp />;
  return <Viewer />;
}
