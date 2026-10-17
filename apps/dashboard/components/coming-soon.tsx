import { Card, CardDescription, CardTitle } from '@/components/ui/card';

export function ComingSoon({
  title,
  task,
  summary,
}: {
  title: string;
  task: string;
  summary: string;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{title}</h1>
      <Card>
        <CardTitle>Coming in {task}</CardTitle>
        <CardDescription>{summary}</CardDescription>
      </Card>
    </div>
  );
}
