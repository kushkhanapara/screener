import { useEffect, useState } from "react"
import { CircleCheck, TrendingUp, TrendingDown } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { getStrategy, type StrategyConditions } from "@/lib/api"

/** Read-only card describing the active Long/Short strategy (from /api/strategy). */
export function StrategySection() {
  const [conditions, setConditions] = useState<StrategyConditions | null>(null)

  useEffect(() => {
    getStrategy()
      .then(setConditions)
      .catch(() => setConditions({ long: [], short: [] }))
  }, [])

  const list = (items: string[], side: "long" | "short") => (
    <ul className="grid gap-2.5 sm:grid-cols-2">
      {items.map((c) => (
        <li key={c} className="flex items-start gap-2 text-sm">
          <CircleCheck
            className={side === "long" ? "mt-0.5 size-4 shrink-0 text-emerald-600" : "mt-0.5 size-4 shrink-0 text-red-600"}
          />
          <span>{c}</span>
        </li>
      ))}
    </ul>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active strategy</CardTitle>
        <CardDescription>
          Evaluated on the underlying equity chart. A scrip qualifies when all of a side's
          conditions hold (standing state).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {conditions === null ? (
          <div className="space-y-2.5">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-3/5" />
          </div>
        ) : (
          <Tabs defaultValue="long">
            <TabsList>
              <TabsTrigger value="long">
                <TrendingUp className="text-emerald-600" /> Long
              </TabsTrigger>
              <TabsTrigger value="short">
                <TrendingDown className="text-red-600" /> Short
              </TabsTrigger>
            </TabsList>
            <TabsContent value="long" className="mt-4">
              {list(conditions.long, "long")}
            </TabsContent>
            <TabsContent value="short" className="mt-4">
              {list(conditions.short, "short")}
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  )
}
