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
import { conditionWord } from "@/lib/glossary"

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
            className={side === "long" ? "mt-0.5 size-4 shrink-0 text-up" : "mt-0.5 size-4 shrink-0 text-down"}
          />
          <span>
            {conditionWord(c)} <span className="text-muted-foreground font-mono text-[11px]">({c})</span>
          </span>
        </li>
      ))}
    </ul>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Screener rules</CardTitle>
        <CardDescription>
          Checked on each stock's own price chart (3-minute and 15-minute). A stock is listed when every rule
          for that side is true right now. This screener only lists stocks — it doesn't trade.
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
                <TrendingUp className="text-up" /> Buy rules
              </TabsTrigger>
              <TabsTrigger value="short">
                <TrendingDown className="text-down" /> Sell rules
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
