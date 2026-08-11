/**
 * The one loading screen.
 *
 * There were eight of these, and half rendered a bare spinning `<span>` with
 * no text in it — which is a blank screen to anyone not looking at the
 * animation, with nothing to say whether the app is working or broken. The
 * label is always present; `visible` decides whether it is also drawn, since
 * the participant screens show it and the admin panels are momentary.
 */
export default function Loading({
  label = 'Loading…',
  visible = false,
}: {
  label?: string;
  visible?: boolean;
}) {
  return (
    <div className="loading-screen" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className={visible ? undefined : 'vh'}>{label}</span>
    </div>
  );
}
