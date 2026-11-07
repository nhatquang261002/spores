// What pages share: the header, and the page for an address that doesn't exist.
import { Link } from 'react-router';
import { useApp } from '../state/source';
import { EmptyState } from '../ui/states';
import { SourceBadge } from '../ui/status';

export function PageHeader({ title }: { title: string }) {
  const { source, epoch } = useApp();
  return (
    <div className="page-header">
      <h1 className="title">{title}</h1>
      {source && <SourceBadge source={source} staleSince={epoch.staleSince} />}
    </div>
  );
}

export function NotFound() {
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState title="There is no page at this address">
        <Link to="/">Go to the home page</Link>.
      </EmptyState>
    </>
  );
}
