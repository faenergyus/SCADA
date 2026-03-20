/**
 * Gibbs Wave Equation — Downhole Card Calculator
 *
 * Calculates the downhole (pump) dynamometer card from the surface card
 * using the Fourier series solution to the 1D damped wave equation.
 *
 * Method (Gibbs, 1963):
 *  1. Decompose surface displacement u(0,t) into Fourier harmonics
 *  2. For each harmonic, compute displacement at pump depth x=L
 *     using the analytical solution with damping
 *  3. Compute downhole load from: F(L,t) = F_surface(t) propagated
 *     through rod dynamics, minus rod weight effects
 *
 * Reference: Gibbs, S.G. "Predicting the Behavior of Sucker-Rod Pumping Systems"
 *            JPT, July 1963; SPE-588-PA
 */

var WaveEquation = (function () {
    'use strict';

    var STEEL_WEIGHT_DENSITY = 0.2833;  // lbf/in³
    var STEEL_ELASTICITY = 30.5e6;      // psi (lbf/in²)
    var GRAVITY = 386.4;                // in/s²
    var PI = Math.PI;

    function buildRodModel(rodSections, wellDetails) {
        if (!rodSections || rodSections.length === 0) return null;

        var sections = rodSections.slice().sort(function (a, b) {
            return (a.RodNum || 0) - (b.RodNum || 0);
        });

        var totalLength = 0;
        var model = [];

        for (var i = 0; i < sections.length; i++) {
            var s = sections[i];
            var lenIn = (s.Length || 0) * 12;
            var diam = s.Diameter || 0.75;
            var E = s.Elasticity || STEEL_ELASTICITY;
            var matlID = s.RodMatlID || 1;
            var weightDensity = (matlID === 4) ? 0.065 : STEEL_WEIGHT_DENSITY;
            var area = PI * diam * diam / 4;

            model.push({
                rodNum: s.RodNum,
                length: lenIn,
                diameter: diam,
                area: area,
                elasticity: E,
                weightDensity: weightDensity,
                waveSpeed: Math.sqrt(E * GRAVITY / weightDensity),
                weightPerIn: weightDensity * area,
                EA: E * area,
            });
            totalLength += lenIn;
        }

        var pumpDepth = (wellDetails.PumpDepth || 0) * 12;
        if (pumpDepth === 0) pumpDepth = totalLength;

        return {
            sections: model,
            totalLength: totalLength,
            pumpDepth: pumpDepth,
            spm: wellDetails.SPM || 8,
            strokeLength: wellDetails.StrokeLength || 100,
            plungerDiam: wellDetails.PlungerDiam || 1.5,
            fluidSG: wellDetails.FluidSpecificGravity || wellDetails.WaterSG || 1.0,
            tubingPressure: wellDetails.TubingPressure || 0,
            casingPressure: wellDetails.CasingPressure || 0,
        };
    }

    /**
     * Compute Fourier coefficients (DFT) of a real signal.
     */
    function dft(signal, nHarmonics) {
        var M = signal.length;
        var cosCoeff = new Array(nHarmonics + 1);
        var sinCoeff = new Array(nHarmonics + 1);
        for (var n = 0; n <= nHarmonics; n++) {
            var ac = 0, as = 0;
            for (var t = 0; t < M; t++) {
                var theta = 2 * PI * n * t / M;
                ac += signal[t] * Math.cos(theta);
                as += signal[t] * Math.sin(theta);
            }
            cosCoeff[n] = 2 * ac / M;
            sinCoeff[n] = 2 * as / M;
        }
        cosCoeff[0] /= 2;
        sinCoeff[0] = 0;
        return { cos: cosCoeff, sin: sinCoeff };
    }

    /**
     * Reconstruct signal from Fourier coefficients.
     */
    function idft(cosCoeff, sinCoeff, M) {
        var nH = cosCoeff.length - 1;
        var result = new Array(M);
        for (var t = 0; t < M; t++) {
            var val = cosCoeff[0];
            for (var n = 1; n <= nH; n++) {
                var theta = 2 * PI * n * t / M;
                val += cosCoeff[n] * Math.cos(theta) + sinCoeff[n] * Math.sin(theta);
            }
            result[t] = val;
        }
        return result;
    }

    /**
     * Calculate the downhole card.
     *
     * For a uniform rod of length L, wave speed c, and damping ζ:
     *
     * The pump displacement for harmonic n (freq = nω) is:
     *   u_pump(n) = u_surface(n) / [cos(βL) + j·ζ·sin(βL)]
     *   where β = nω/c (wave number)
     *
     * The pump load is computed from the strain at the pump:
     *   F_pump(n) = -E·A · ∂u/∂x|_{x=L}
     *
     * For the nth harmonic:
     *   F_pump(n) = E·A·β · u_surface(n) · [sin(βL) + j·ζ·cos(βL)] / [cos(βL) + j·ζ·sin(βL)]
     *            = E·A·β · u_surface(n) · tan_damped(βL, ζ)
     */
    function calculateDownholeCard(surfacePosition, surfaceLoad, rodModel, options) {
        if (!rodModel || !surfacePosition || !surfaceLoad) return null;
        if (surfacePosition.length < 10) return null;

        var opts = options || {};
        var zeta = opts.dampingFactor || 0.10;
        var nH = opts.nHarmonics || 20;
        var M = surfacePosition.length;

        var omega = 2 * PI * rodModel.spm / 60;
        var L = rodModel.pumpDepth;

        // Effective rod properties (weighted by length fraction)
        var avgC = 0, weightedEA = 0, totalBuoyantWt = 0;
        var buoyFactor = 1 - rodModel.fluidSG * 62.4 / (STEEL_WEIGHT_DENSITY * 1728);

        for (var s = 0; s < rodModel.sections.length; s++) {
            var sec = rodModel.sections[s];
            var frac = sec.length / L;
            avgC += sec.waveSpeed * frac;
            weightedEA += sec.EA * frac;
            totalBuoyantWt += sec.weightPerIn * sec.length * buoyFactor;
        }

        // Surface displacement (relative)
        var minPos = Math.min.apply(null, surfacePosition);
        var surfDisp = surfacePosition.map(function (p) { return p - minPos; });

        // Fourier decomposition of surface displacement
        var dispDFT = dft(surfDisp, nH);

        // Propagate each harmonic to pump depth
        var pumpDispCos = new Array(nH + 1);
        var pumpDispSin = new Array(nH + 1);
        var pumpLoadCos = new Array(nH + 1);
        var pumpLoadSin = new Array(nH + 1);

        for (var n = 0; n <= nH; n++) {
            var an = dispDFT.cos[n];
            var bn = dispDFT.sin[n];

            if (n === 0) {
                // DC: pump sees same mean displacement
                pumpDispCos[0] = an;
                pumpDispSin[0] = 0;
                // DC load at pump (no dynamics, just static)
                pumpLoadCos[0] = 0;
                pumpLoadSin[0] = 0;
                continue;
            }

            var nOmega = n * omega;
            var beta = nOmega / avgC;
            var betaL = beta * L;

            var cosBL = Math.cos(betaL);
            var sinBL = Math.sin(betaL);

            // Denominator D = cos(βL) + j·ζ_n·sin(βL)
            // Frequency-dependent damping: higher harmonics get more damping
            // This models viscous + Coulomb friction in the rod string
            var zeta_n = zeta * Math.sqrt(n);

            var dR = cosBL;
            var dI = zeta_n * sinBL;
            var dMag2 = dR * dR + dI * dI;
            if (dMag2 < 0.01) dMag2 = 0.01;  // resonance protection

            // Pump displacement: u_pump = u_surface / D
            // (an + j·bn) / (dR + j·dI) = [(an·dR + bn·dI) + j·(bn·dR - an·dI)] / dMag2
            pumpDispCos[n] = (an * dR + bn * dI) / dMag2;
            pumpDispSin[n] = (bn * dR - an * dI) / dMag2;

            // Pump load from strain: F = EA·β · u_surface · [sin(βL) + j·ζ·cos(βL)] / D
            // Numerator N = (sin(βL) + j·ζ·cos(βL)) · (an + j·bn)
            var nR = sinBL;
            var nI = zeta_n * cosBL;
            // N · input = (nR + j·nI)(an + j·bn) = (nR·an - nI·bn) + j·(nR·bn + nI·an)
            var prodR = nR * an - nI * bn;
            var prodI = nR * bn + nI * an;
            // Divide by D
            var fR = (prodR * dR + prodI * dI) / dMag2;
            var fI = (prodI * dR - prodR * dI) / dMag2;

            pumpLoadCos[n] = weightedEA * beta * fR;
            pumpLoadSin[n] = weightedEA * beta * fI;
        }

        // Reconstruct pump displacement and load
        var pumpDisp = idft(pumpDispCos, pumpDispSin, M);
        var pumpForce = idft(pumpLoadCos, pumpLoadSin, M);

        // The pump load = strain-derived force
        // This represents the net force at the pump (approximately equal to
        // fluid load on upstroke, near zero on downstroke for a full pump)

        // Normalize position
        var minDH = Math.min.apply(null, pumpDisp);
        var resultPos = pumpDisp.map(function (d) {
            return Math.round((d - minDH) * 100) / 100;
        });
        var resultLoad = pumpForce.map(function (f) {
            return Math.round(f);
        });

        var f1 = avgC / (4 * L);

        return {
            position: resultPos,
            load: resultLoad,
            meta: {
                method: 'Gibbs Wave Equation (Fourier)',
                nHarmonics: nH,
                dampingFactor: zeta,
                pumpDepthFt: Math.round(L / 12),
                rodSections: rodModel.sections.length,
                avgWaveSpeedFtS: Math.round(avgC / 12),
                naturalFreqHz: Math.round(f1 * 100) / 100,
                freqRatio: Math.round(omega / (2 * PI * f1) * 1000) / 1000,
                buoyantRodWt: Math.round(totalBuoyantWt),
            }
        };
    }

    function idealDownholeCard(rodModel, netStroke) {
        if (!rodModel) return null;
        var plungerArea = PI * rodModel.plungerDiam * rodModel.plungerDiam / 4;
        var fluidLoadPSI = rodModel.fluidSG * 0.433;
        var pumpDepthFt = rodModel.pumpDepth / 12;
        var fluidLoad = fluidLoadPSI * pumpDepthFt * plungerArea;
        var tubLoad = rodModel.tubingPressure * plungerArea;
        var casLoad = rodModel.casingPressure * plungerArea;
        var upLoad = fluidLoad + tubLoad - casLoad;
        var downLoad = Math.max(0, tubLoad - casLoad);
        var stroke = netStroke || rodModel.strokeLength * 0.9;

        var N = 100, pos = [], load = [];
        for (var i = 0; i < N; i++) {
            var f = i / (N - 1);
            if (f < 0.02) {
                pos.push(0);
                load.push(downLoad + (upLoad - downLoad) * f / 0.02);
            } else if (f < 0.5) {
                pos.push(stroke * (f - 0.02) / 0.48);
                load.push(upLoad);
            } else if (f < 0.52) {
                pos.push(stroke);
                load.push(upLoad - (upLoad - downLoad) * (f - 0.5) / 0.02);
            } else {
                pos.push(stroke * (1 - (f - 0.52) / 0.48));
                load.push(downLoad);
            }
        }
        return { position: pos, load: load, meta: {
            fluidLoad: Math.round(upLoad), downstrokeLoad: Math.round(downLoad),
        }};
    }

    return {
        buildRodModel: buildRodModel,
        calculateDownholeCard: calculateDownholeCard,
        idealDownholeCard: idealDownholeCard,
    };
})();
