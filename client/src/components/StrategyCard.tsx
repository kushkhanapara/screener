import { useEffect, useState } from "react"
import { CircleCheck } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { getStrategy } from "@/lib/api"

/** Read-only card describing the active strategy (from /api/strategy). */
export function StrategySection() {
  const [conditions, setConditions] = useState<string[] | null>(null)

  useEffect(() => {
    getStrategy()
      .then((d) => setConditions(d.conditions))
      .catch(() => setConditions([]))
  }, [])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active strategy</CardTitle>
        <CardDescription>A contract qualifies when all conditions hold.</CardDescription>
        <div className="ml-auto">
          <Badge variant="outline">Long setup</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {conditions === null ? (
          <div className="space-y-2.5">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-3/5" />
          </div>
        ) : (
          <ul className="grid gap-2.5 sm:grid-cols-3">
            {conditions.map((c) => (
              <li key={c} className="flex items-start gap-2 text-sm">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
