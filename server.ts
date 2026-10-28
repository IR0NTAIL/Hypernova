import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const PORT = 3000;

function getGenAIClient() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Server-side Gemini endpoint for Astrophysical Telemetry & System Evolution Analysis
  app.post('/api/gemini/analyze', async (req, res) => {
    try {
      const { mode, systemSummary, selectedBody } = req.body;
      const ai = getGenAIClient();

      const prompt =
        mode === 'body' && selectedBody
          ? `You are an astrophysicist analyzing an emergent celestial body inside the deterministic 3D physics simulation "Hypernova".
Analyze this celestial object based on its exact physical telemetry:
- Name / Designation: ${selectedBody.name}
- Object Class: ${selectedBody.type}
- Mass: ${selectedBody.massSolar?.toFixed(4)} Solar Masses (${selectedBody.massJupiter?.toFixed(2)} Jupiter Masses)
- Core Temperature: ${Math.round(selectedBody.coreTemperature).toLocaleString()} K
- Surface Temperature: ${Math.round(selectedBody.temperature).toLocaleString()} K
- Active Fusion Stage: ${selectedBody.fusionStage}
- Composition (Mass Fractions): H ${(selectedBody.composition.H * 100).toFixed(1)}%, He ${(selectedBody.composition.He * 100).toFixed(1)}%, C ${(selectedBody.composition.C * 100).toFixed(1)}%, O ${(selectedBody.composition.O * 100).toFixed(1)}%, Si ${(selectedBody.composition.Si * 100).toFixed(1)}%, Fe ${(selectedBody.composition.Fe * 100).toFixed(1)}%
- Accretion Disk Mass: ${(selectedBody.accretionDiskMass || 0).toFixed(4)} M☉

Provide a concise, scientifically rigorous astrophysical analysis explaining its current hydrostatic/thermodynamic state, nucleosynthesis pathway, and ultimate stellar fate.`
          : `You are an astrophysicist observing an emergent N-body & thermodynamic space simulation called "Hypernova".
Current Simulation Telemetry:
- Simulated Cosmic Time: ${systemSummary?.simTimeMyr?.toFixed(2) || 0} Myr
- Deterministic RNG Seed: ${systemSummary?.seed || 'HYPERNOVA-1'}
- Loose Gas/Dust Particles: ${systemSummary?.particleCount || 0}
- Condensed Celestial Bodies: ${systemSummary?.bodyCount || 0}
- Body Breakdown: ${JSON.stringify(systemSummary?.bodies || [])}
- Recent Cosmic Events: ${JSON.stringify(systemSummary?.recentEvents || [])}

Provide a concise astrophysical briefing on the current state of this simulated region of space, how Jeans instability and conservation of angular momentum are shaping it, and suggest one specific element-spawning experiment the observer can perform next.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              headline: {
                type: Type.STRING,
                description: 'Short scientific title for the spectroscopic/astrophysical report.',
              },
              thermodynamicState: {
                type: Type.STRING,
                description: '2-3 sentences analyzing gravity, Jeans collapse, temperature, and pressure balance.',
              },
              nucleosynthesisAndFate: {
                type: Type.STRING,
                description: '2-3 sentences explaining the fusion chain, heavy element enrichment, and predicted remnant outcome.',
              },
              recommendedExperiment: {
                type: Type.STRING,
                description: '1 concrete suggestion for which elements (H, He, C, O, Si, Fe) or time multiplier to apply next.',
              },
            },
            required: [
              'headline',
              'thermodynamicState',
              'nucleosynthesisAndFate',
              'recommendedExperiment',
            ],
          },
        },
      });

      const text = response.text || '{}';
      const parsed = JSON.parse(text);
      res.json(parsed);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Astrophysical telemetry analysis failed.';
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Hypernova server running on http://localhost:${PORT}`);
  });
}

startServer();
