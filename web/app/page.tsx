export default function Home() {
  return (
    <div className="container mx-auto px-4 py-16">
      <div className="max-w-4xl mx-auto text-center space-y-8">
        <h1 className="text-5xl font-bold tracking-tight">
          AI-Driven Chip Design Automation
        </h1>

        <p className="text-xl text-muted-foreground">
          Transform natural language specifications into production-ready RTL in minutes.
        </p>

        <div className="grid md:grid-cols-2 gap-6 mt-12">
          <a
            href="/design"
            className="p-8 border rounded-lg hover:border-primary transition-colors"
          >
            <h2 className="text-2xl font-semibold mb-3">Design Dragon</h2>
            <p className="text-muted-foreground">
              Generate synthesizable Verilog RTL from natural language specifications.
            </p>
            <div className="mt-4 text-primary">
              Generate RTL →
            </div>
          </a>

          <a
            href="/verify"
            className="p-8 border rounded-lg hover:border-primary transition-colors"
          >
            <h2 className="text-2xl font-semibold mb-3">Verification Dragon</h2>
            <p className="text-muted-foreground">
              Automatically generate testbenches and verify RTL functionality.
            </p>
            <div className="mt-4 text-primary">
              Verify RTL →
            </div>
          </a>
        </div>

        <div className="mt-16 pt-16 border-t">
          <h3 className="text-2xl font-semibold mb-6">Key Features</h3>
          <div className="grid md:grid-cols-3 gap-6 text-left">
            <div>
              <h4 className="font-semibold mb-2">Natural Language Input</h4>
              <p className="text-sm text-muted-foreground">
                Describe your design in plain English. No HDL expertise required.
              </p>
            </div>
            <div>
              <h4 className="font-semibold mb-2">Lint-Clean RTL</h4>
              <p className="text-sm text-muted-foreground">
                Generated code passes Verilator lint checks automatically.
              </p>
            </div>
            <div>
              <h4 className="font-semibold mb-2">Automated Testing</h4>
              <p className="text-sm text-muted-foreground">
                Generate comprehensive testbenches with coverage analysis.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
