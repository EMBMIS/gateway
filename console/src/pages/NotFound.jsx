import { EmptyState } from '../components/ui'

export default function NotFound() {
  return <EmptyState title="That page does not exist" description="The address may be mistyped, or the page moved. Use the navigation, or press ⌘K to search." actionTo="/" actionLabel="Go to the dashboard" />
}
