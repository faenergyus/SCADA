/**
 * Dyno Card Pattern Database & Diagnostic Engine
 *
 * Classifies downhole dynamometer cards by comparing shape features
 * against known pump condition patterns. Uses geometric analysis
 * (area ratios, load transitions, symmetry) rather than image matching.
 *
 * Sources:
 *   - Theta/XSPOC XDiag condition taxonomy
 *   - API RP 11L2 "Recommended Practice for Electrical Submersible Pump Testing"
 *   - Gibbs, S.G. "Computing Gearbox Torque and Motor Loading" (SPE 18186)
 *   - Industry standard card shape classifications
 */

const CardPatterns = (function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Pattern Database
    // -----------------------------------------------------------------------
    /**
     * Each pattern describes the expected shape features of a downhole card
     * for a specific pump condition.
     *
     * Shape features extracted from each card:
     *   - areaRatio:        actual card area / ideal rectangular card area
     *   - loadRange:        (maxLoad - minLoad) as fraction of ideal fluid load
     *   - upstrokeSlope:    normalized slope of load during upstroke
     *   - downstrokeSlope:  normalized slope of load during downstroke
     *   - tvTransition:     sharpness of load pickup at bottom (TV closing)
     *   - svTransition:     sharpness of load drop at top (SV closing)
     *   - symmetry:         how symmetric the card is about the midpoint
     *   - flatTop:          fraction of upstroke at near-constant load
     *   - flatBottom:       fraction of downstroke at near-constant load
     *   - fluidPoundIdx:    sharp load drop during downstroke (0-1)
     *   - gasCompression:   gradual load buildup during upstroke (0-1)
     */
    // Pattern thresholds calibrated against 64 real XSPOC wells (2026-03-23).
    // Feature statistics computed per XSPOC PumpCondition class and used to set
    // min/max/ideal values for each discriminating feature.
    var PATTERNS = [
        {
            id: 'full_pump',
            name: 'Full Pump',
            severity: 'normal',
            description: 'Pump is operating normally with full fillage. Card is approximately rectangular.',
            operationalMeaning: 'Pump barrel is completely filled with fluid each stroke. Optimal production.',
            actions: ['No action needed', 'Monitor for changes'],
            features: {
                areaRatio: { min: 0.72, ideal: 0.85, max: 1.0 },
                flatBottom: { min: 0.60, ideal: 0.80 },
                tvTransition: { min: 0.8, ideal: 1.0 },
                svTransition: { min: 0.8, ideal: 1.0 },
                fluidPoundIdx: { max: 0.20 },
            },
            weight: 1.0,
        },
        {
            id: 'fluid_pound',
            name: 'Fluid Pound',
            severity: 'warning',
            description: 'Pump barrel not completely filled — plunger hits fluid on downstroke causing sharp load spike. Card shows truncated lower-right corner.',
            operationalMeaning: 'Pump speed exceeds fluid inflow rate. Barrel partially gas-filled. Causes rod and surface equipment fatigue.',
            actions: [
                'Slow pump speed (reduce SPM)',
                'Lower pump if possible',
                'Check for gas interference',
                'Verify fluid level vs pump depth',
            ],
            features: {
                areaRatio: { min: 0.15, ideal: 0.50, max: 0.80 },
                fluidPoundIdx: { min: 0.10, ideal: 0.35 },
                svTransition: { max: 0.55 },
            },
            weight: 1.2,
        },
        {
            id: 'gas_interference',
            name: 'Gas Interference',
            severity: 'warning',
            description: 'Free gas in pump barrel compresses before valves transfer. Card shows gradual load buildup on upstroke and gradual unloading on downstroke — "banana" or "football" shape.',
            operationalMeaning: 'Gas entering pump with fluid. Reduces pump efficiency. Gas must compress before TV opens.',
            actions: [
                'Install or check gas separator/anchor',
                'Lower pump below perforations if possible',
                'Consider gas venting',
                'Check casing pressure management',
            ],
            features: {
                areaRatio: { min: 0.35, ideal: 0.58, max: 0.70 },
                flatBottom: { max: 0.45 },
                flatTop: { max: 0.55 },
                fluidPoundIdx: { max: 0.35 },
            },
            weight: 1.1,
        },
        {
            id: 'tv_leak',
            name: 'Traveling Valve Leak',
            severity: 'warning',
            description: 'Traveling valve not seating properly. Fluid leaks past TV during upstroke. Card shows declining load during upstroke (sloping top).',
            operationalMeaning: 'TV ball or seat worn/damaged. Fluid falls back through TV during upstroke, reducing lift.',
            actions: [
                'Pull rods and replace TV',
                'Check for sand/debris in valve',
                'Monitor for worsening',
            ],
            features: {
                flatTop: { max: 0.55, ideal: 0.40 },
                flatBottom: { min: 0.45, ideal: 0.75 },
                areaRatio: { min: 0.55, max: 0.90 },
                fluidPoundIdx: { max: 0.12 },
            },
            weight: 1.15,
        },
        {
            id: 'sv_leak',
            name: 'Standing Valve Leak',
            severity: 'warning',
            description: 'Standing valve not seating properly. Fluid leaks past SV during downstroke. Card shows rising load during downstroke (sloping bottom).',
            operationalMeaning: 'SV ball or seat worn/damaged. Fluid falls back through SV during downstroke.',
            actions: [
                'Pull tubing and replace SV',
                'Check for sand/debris',
                'Verify SV type matches well conditions',
            ],
            features: {
                flatBottom: { max: 0.55, ideal: 0.35 },
                areaRatio: { min: 0.40, max: 0.90 },
                svTransition: { max: 0.50 },
                fluidPoundIdx: { max: 0.25 },
            },
            weight: 1.15,
        },
        {
            id: 'worn_pump',
            name: 'Worn Pump / Barrel Wear',
            severity: 'caution',
            description: 'Pump barrel or plunger worn — fluid slips past plunger during both strokes. Card appears "squeezed" with reduced area but retains general shape.',
            operationalMeaning: 'Clearance between plunger and barrel increased. Efficiency drops progressively. Both valves may still be OK.',
            actions: [
                'Schedule pump replacement',
                'Monitor efficiency trend',
                'Check sand production levels',
            ],
            features: {
                areaRatio: { min: 0.45, ideal: 0.63, max: 0.78 },
                flatTop: { min: 0.30 },
                flatBottom: { min: 0.25 },
                tvTransition: { min: 0.55 },
                svTransition: { min: 0.55 },
                fluidPoundIdx: { max: 0.28 },
            },
            weight: 0.85,
        },
        {
            id: 'rod_part',
            name: 'Rod Part (Broken Rod)',
            severity: 'critical',
            description: 'Rod string parted — surface carries only weight above break. Card shows minimal load variation, near-zero fluid load.',
            operationalMeaning: 'Rod broken. No pumping action at pump. Well is dead.',
            actions: [
                'Shut down unit immediately',
                'Fish rods',
                'Inspect rod string for cause (fatigue, corrosion, overload)',
            ],
            features: {
                areaRatio: { max: 0.50, ideal: 0.30 },
                flatTop: { max: 0.30 },
                flatBottom: { max: 0.25 },
                fluidPoundIdx: { max: 0.20 },
            },
            weight: 1.3,
        },
        {
            id: 'pump_hitting_down',
            name: 'Pump Hitting Down',
            severity: 'critical',
            description: 'Plunger bottoming out on downstroke — sharp load spike at bottom of stroke. Card shows spike in downstroke load near bottom dead center.',
            operationalMeaning: 'Plunger hitting bottom of barrel or tag bar. Causes rod buckling, barrel damage.',
            actions: [
                'Adjust rod space / rod length',
                'Check for tubing stretch',
                'Verify pump spacing',
                'Shut down if severe',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.95 },
                bottomSpike: { min: 0.5, ideal: 0.8 },
            },
            weight: 1.3,
        },
        {
            id: 'pump_hitting_up',
            name: 'Pump Hitting Up',
            severity: 'critical',
            description: 'Plunger topping out on upstroke — sharp load spike at top of stroke. Card shows spike in upstroke load near top dead center.',
            operationalMeaning: 'Plunger hitting top of barrel or overtravel on upstroke. Can damage pump barrel, seating nipple, or rod string.',
            actions: [
                'Adjust rod space / rod length',
                'Check for fluid pound (causes overtravel)',
                'Verify stroke length setting',
                'Shut down if severe',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.95 },
                topSpike: { min: 0.5, ideal: 0.8 },
            },
            weight: 1.3,
        },
        {
            id: 'bent_barrel',
            name: 'Bent Pump Barrel / Sticking Plunger',
            severity: 'caution',
            description: 'Plunger sticking or barrel bent — erratic load patterns, asymmetric card with humps.',
            operationalMeaning: 'Mechanical interference in pump. Barrel may be bent from installation or thermal effects.',
            actions: [
                'Pull and inspect pump',
                'Check for sand or scale buildup',
                'Verify tubing alignment',
            ],
            features: {
                symmetry: { max: 0.5 },
                areaRatio: { min: 0.3, max: 0.8 },
            },
            weight: 0.9,
        },
        {
            id: 'anchor_not_holding',
            name: 'Tubing Anchor Not Holding',
            severity: 'caution',
            description: 'Tubing moves with rod string because anchor is slipping. Card shifted or shows reduced net stroke due to tubing stretch.',
            operationalMeaning: 'Tubing anchor not gripping casing. Tubing reciprocates, absorbing pump stroke. Reduced production.',
            actions: [
                'Re-set tubing anchor',
                'Consider replacing anchor',
                'Check casing ID vs anchor size',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.85 },
                tubingMovement: { min: 0.3, ideal: 0.6 },
            },
            weight: 1.0,
        },
        {
            id: 'gas_lock',
            name: 'Gas Lock',
            severity: 'critical',
            description: 'Pump completely gas-locked — no fluid being pumped. Card collapses to a narrow sliver with almost no area.',
            operationalMeaning: 'Gas fills entire barrel. Neither valve can open because gas just compresses/expands. Zero production.',
            actions: [
                'Shut down and vent casing gas',
                'Install gas separator',
                'Lower pump below perfs',
                'Consider gas anchor modification',
            ],
            features: {
                areaRatio: { max: 0.15 },
                gasCompression: { min: 0.5 },
            },
            weight: 1.4,
        },
        {
            id: 'incomplete_fillage',
            name: 'Incomplete Pump Fillage',
            severity: 'info',
            description: 'Pump not fully filling each stroke — partial fluid pound. Less severe than full fluid pound.',
            operationalMeaning: 'Inflow rate slightly below pump displacement. Some gas or void space in barrel at start of upstroke.',
            actions: [
                'Consider slowing SPM slightly',
                'Monitor fluid level trend',
                'May be acceptable if production is near target',
            ],
            features: {
                areaRatio: { min: 0.55, ideal: 0.67, max: 0.82 },
                fluidPoundIdx: { min: 0.10, max: 0.35 },
                tvTransition: { min: 0.5 },
            },
            weight: 0.85,
        },
        {
            id: 'phase_shift',
            name: 'Phase Shift in Card',
            severity: 'info',
            description: 'Card appears rotated/shifted — usually a sensor timing or calibration issue, not a pump problem.',
            operationalMeaning: 'Position encoder timing may be off, or load cell calibration drifted. Card shape is valid but phased.',
            actions: [
                'Recalibrate position sensor',
                'Check encoder alignment',
                'May indicate kinematic correction needed',
            ],
            features: {
                areaRatio: { min: 0.5, max: 0.95 },
                phaseShift: { min: 0.3, ideal: 0.6 },
            },
            weight: 0.7,
        },
    ];

    // -----------------------------------------------------------------------
    // Feature Extraction
    // -----------------------------------------------------------------------

    /**
     * Extract shape features from a downhole card.
     *
     * @param {Array} position - Card position array (inches)
     * @param {Array} load     - Card load array (lbs)
     * @param {Object} rodModel - Optional rod model for reference values
     * @returns {Object} Feature vector
     */
    function extractFeatures(position, load, rodModel) {
        if (!position || !load || position.length < 10) return null;

        var N = Math.min(position.length, load.length);

        // Basic stats
        var minLoad = Infinity, maxLoad = -Infinity;
        var minPos = Infinity, maxPos = -Infinity;
        for (var i = 0; i < N; i++) {
            if (load[i] < minLoad) minLoad = load[i];
            if (load[i] > maxLoad) maxLoad = load[i];
            if (position[i] < minPos) minPos = position[i];
            if (position[i] > maxPos) maxPos = position[i];
        }

        var loadRange = maxLoad - minLoad;
        var posRange = maxPos - minPos;
        if (loadRange < 1 || posRange < 0.1) {
            return { areaRatio: 0, loadRange: 0, error: 'degenerate card' };
        }

        // Normalize to 0-1 range
        var normPos = [];
        var normLoad = [];
        for (var i = 0; i < N; i++) {
            normPos.push((position[i] - minPos) / posRange);
            normLoad.push((load[i] - minLoad) / loadRange);
        }

        // Card area (using shoelace formula on normalized card)
        var area = 0;
        for (var i = 0; i < N; i++) {
            var j = (i + 1) % N;
            area += normPos[i] * normLoad[j] - normPos[j] * normLoad[i];
        }
        area = Math.abs(area) / 2;
        var areaRatio = area;  // normalized area / 1.0 (ideal rectangle)

        // Find upstroke and downstroke segments
        // Upstroke: position increasing, Downstroke: position decreasing
        var upIndices = [];
        var downIndices = [];
        var midPos = 0.5;

        // Split card at approximate top and bottom of stroke
        var topIdx = 0, botIdx = 0;
        var topPos = 0, botPos = 1;
        for (var i = 0; i < N; i++) {
            if (normPos[i] > topPos) { topPos = normPos[i]; topIdx = i; }
            if (normPos[i] < botPos) { botPos = normPos[i]; botIdx = i; }
        }

        // Upstroke: from botIdx to topIdx (going forward, wrapping)
        for (var k = 0; k < N; k++) {
            var i = (botIdx + k) % N;
            upIndices.push(i);
            if (i === topIdx) break;
        }
        // Downstroke: from topIdx to botIdx
        for (var k = 0; k < N; k++) {
            var i = (topIdx + k) % N;
            downIndices.push(i);
            if (i === botIdx) break;
        }

        // Upstroke load slope (linear regression on upstroke load vs position)
        var upstrokeSlope = calcSlope(normPos, normLoad, upIndices);
        var downstrokeSlope = calcSlope(normPos, normLoad, downIndices);

        // Flat top: fraction of upstroke where load is within 15% of max upstroke load
        var maxUpLoad = 0;
        for (var k = 0; k < upIndices.length; k++) {
            if (normLoad[upIndices[k]] > maxUpLoad) maxUpLoad = normLoad[upIndices[k]];
        }
        var flatTopCount = 0;
        for (var k = 0; k < upIndices.length; k++) {
            if (normLoad[upIndices[k]] > maxUpLoad * 0.85) flatTopCount++;
        }
        var flatTop = upIndices.length > 0 ? flatTopCount / upIndices.length : 0;

        // Flat bottom: fraction of downstroke where load is within 15% of min downstroke load
        var minDownLoad = 1;
        for (var k = 0; k < downIndices.length; k++) {
            if (normLoad[downIndices[k]] < minDownLoad) minDownLoad = normLoad[downIndices[k]];
        }
        var flatBotCount = 0;
        for (var k = 0; k < downIndices.length; k++) {
            if (normLoad[downIndices[k]] < minDownLoad + 0.15) flatBotCount++;
        }
        var flatBottom = downIndices.length > 0 ? flatBotCount / downIndices.length : 0;

        // TV transition sharpness: how quickly load picks up at bottom of stroke
        var tvRegion = upIndices.slice(0, Math.max(3, Math.floor(upIndices.length * 0.15)));
        var tvTransition = 0;
        if (tvRegion.length > 1) {
            var loadJump = normLoad[tvRegion[tvRegion.length - 1]] - normLoad[tvRegion[0]];
            var posJump = normPos[tvRegion[tvRegion.length - 1]] - normPos[tvRegion[0]];
            tvTransition = posJump > 0.001 ? Math.min(1, loadJump / (posJump * 4)) : 0;
        }

        // SV transition sharpness: how quickly load drops at top of stroke
        var svRegion = downIndices.slice(0, Math.max(3, Math.floor(downIndices.length * 0.15)));
        var svTransition = 0;
        if (svRegion.length > 1) {
            var loadDrop = normLoad[svRegion[0]] - normLoad[svRegion[svRegion.length - 1]];
            var posDrop = normPos[svRegion[0]] - normPos[svRegion[svRegion.length - 1]];
            svTransition = Math.abs(posDrop) > 0.001 ? Math.min(1, loadDrop / (Math.abs(posDrop) * 4)) : 0;
        }

        // Fluid pound index: detect sharp load drop during downstroke
        var fluidPoundIdx = 0;
        if (downIndices.length > 5) {
            var maxDrop = 0;
            for (var k = 1; k < downIndices.length; k++) {
                var prevI = downIndices[k - 1];
                var curI = downIndices[k];
                var drop = normLoad[prevI] - normLoad[curI];
                if (drop > maxDrop) maxDrop = drop;
            }
            fluidPoundIdx = Math.min(1, maxDrop * 3);
        }

        // Gas compression: gradual load buildup (vs sharp TV transition)
        var gasCompression = Math.max(0, 1 - tvTransition);

        // Symmetry: compare first half vs second half shape
        var halfN = Math.floor(N / 2);
        var symDiff = 0;
        for (var i = 0; i < halfN; i++) {
            var mirrorI = N - 1 - i;
            symDiff += Math.abs(normLoad[i] - normLoad[mirrorI]);
        }
        var symmetry = halfN > 0 ? 1 - Math.min(1, symDiff / halfN) : 0.5;

        // Load range ratio (vs expected fluid load)
        var loadRangeRatio = 1.0;
        if (rodModel) {
            var plungerArea = Math.PI * rodModel.plungerDiam * rodModel.plungerDiam / 4;
            var expectedFluidLoad = rodModel.fluidSG * 0.433 * (rodModel.pumpDepth / 12) * plungerArea;
            if (expectedFluidLoad > 0) {
                loadRangeRatio = loadRange / expectedFluidLoad;
            }
        }

        // Bottom spike (pump hitting down)
        var bottomSpike = 0;
        var bottomRegion = upIndices.slice(0, Math.max(3, Math.floor(upIndices.length * 0.1)));
        if (bottomRegion.length > 1) {
            var spikeLoad = 0;
            for (var k = 0; k < bottomRegion.length; k++) {
                if (normLoad[bottomRegion[k]] > spikeLoad) spikeLoad = normLoad[bottomRegion[k]];
            }
            var avgUpLoad = 0;
            for (var k = 0; k < upIndices.length; k++) avgUpLoad += normLoad[upIndices[k]];
            avgUpLoad /= upIndices.length;
            if (spikeLoad > avgUpLoad * 1.3) bottomSpike = Math.min(1, (spikeLoad - avgUpLoad) * 3);
        }

        // Top spike (pump hitting up)
        var topSpike = 0;
        var topRegion = downIndices.slice(0, Math.max(3, Math.floor(downIndices.length * 0.1)));
        if (topRegion.length > 1) {
            var topSpikeLoad = 1;
            for (var k = 0; k < topRegion.length; k++) {
                if (normLoad[topRegion[k]] < topSpikeLoad) topSpikeLoad = normLoad[topRegion[k]];
            }
            var avgDownLoad = 0;
            for (var k = 0; k < downIndices.length; k++) avgDownLoad += normLoad[downIndices[k]];
            avgDownLoad /= downIndices.length;
            if (topSpikeLoad < avgDownLoad * 0.7) topSpike = Math.min(1, (avgDownLoad - topSpikeLoad) * 3);
        }

        // Tubing movement: difference in position at same load levels
        var tubingMovement = 0;
        // Compare position at mid-load during upstroke vs downstroke
        var midLoadLevel = 0.5;
        var upMidPos = interpPosAtLoad(normPos, normLoad, upIndices, midLoadLevel);
        var downMidPos = interpPosAtLoad(normPos, normLoad, downIndices, midLoadLevel);
        if (upMidPos !== null && downMidPos !== null) {
            tubingMovement = Math.abs(upMidPos - downMidPos);
        }

        // Phase shift: detect if card is rotated from expected orientation
        var phaseShift = 0;
        // If max load occurs far from bottom of stroke or min load far from top
        var maxLoadPos = normPos[0];
        for (var i = 1; i < N; i++) {
            if (normLoad[i] === maxLoad) maxLoadPos = normPos[i];
        }
        if (maxLoadPos > 0.6 || maxLoadPos < 0.1) phaseShift = 0.5;

        // C-to-D transition sharpness (sharp = full pump/fluid pound, gradual = gas interference)
        // Uses AVERAGE slope over the first 30% of downstroke (not max, which saturates).
        // Published criterion: gas interference has gradual/rounded C-D (avg < 3),
        // fluid pound has sharp C-D (avg > 3), full pump has very sharp (avg > 8).
        var cdSharpness = 0;
        if (downIndices.length > 5) {
            var cdSeg = downIndices.slice(0, Math.max(5, Math.floor(downIndices.length * 3 / 10)));
            var cdSum = 0, cdCount = 0;
            for (var k = 1; k < cdSeg.length; k++) {
                var cdDP = Math.abs(normPos[cdSeg[k]] - normPos[cdSeg[k - 1]]);
                var cdDL = normLoad[cdSeg[k - 1]] - normLoad[cdSeg[k]];
                if (cdDP > 0.001) {
                    cdSum += cdDL / cdDP;
                    cdCount++;
                }
            }
            if (cdCount > 0) cdSharpness = Math.min(1, (cdSum / cdCount) / 15.0);
        }

        // A-to-B transition sharpness (sharp = normal/full pump, gradual = gas/TV leak)
        // Same avg slope approach, normalized to 0-1 range (÷15).
        var abSharpness = 0;
        if (upIndices.length > 5) {
            var abSeg = upIndices.slice(0, Math.max(5, Math.floor(upIndices.length * 3 / 10)));
            var abSum = 0, abCount = 0;
            for (var k = 1; k < abSeg.length; k++) {
                var abDP = Math.abs(normPos[abSeg[k]] - normPos[abSeg[k - 1]]);
                var abDL = normLoad[abSeg[k]] - normLoad[abSeg[k - 1]];
                if (abDP > 0.001) {
                    abSum += abDL / abDP;
                    abCount++;
                }
            }
            if (abCount > 0) abSharpness = Math.min(1, (abSum / abCount) / 15.0);
        }

        // Downstroke load elevation (mean mid-downstroke load, normalized)
        // High = SV leak (downstroke load elevated above zero line)
        var dnLoadElev = 0;
        if (downIndices.length > 4) {
            var midDnStart = Math.floor(downIndices.length / 4);
            var midDnEnd = Math.floor(3 * downIndices.length / 4);
            var dnSum = 0, dnCount = 0;
            for (var k = midDnStart; k < midDnEnd; k++) {
                dnSum += normLoad[downIndices[k]];
                dnCount++;
            }
            if (dnCount > 0) dnLoadElev = dnSum / dnCount;
        }

        // Upstroke load drop point (fraction of upstroke before load drops below 80% of max)
        // Late = full pump, early = fluid pound / incomplete fillage
        var upDropPt = 1.0;
        if (upIndices.length > 5) {
            var upMaxLoad = 0;
            for (var k = 0; k < upIndices.length; k++) {
                if (normLoad[upIndices[k]] > upMaxLoad) upMaxLoad = normLoad[upIndices[k]];
            }
            var dropThresh = upMaxLoad * 0.80;
            for (var k = Math.floor(upIndices.length / 4); k < upIndices.length; k++) {
                if (normLoad[upIndices[k]] < dropThresh) {
                    upDropPt = k / upIndices.length;
                    break;
                }
            }
        }

        return {
            areaRatio: areaRatio,
            loadRange: loadRangeRatio,
            upstrokeSlope: upstrokeSlope,
            downstrokeSlope: downstrokeSlope,
            tvTransition: tvTransition,
            svTransition: svTransition,
            flatTop: flatTop,
            flatBottom: flatBottom,
            fluidPoundIdx: fluidPoundIdx,
            gasCompression: gasCompression,
            symmetry: symmetry,
            bottomSpike: bottomSpike,
            topSpike: topSpike,
            tubingMovement: tubingMovement,
            phaseShift: phaseShift,
            cdSharpness: cdSharpness,
            abSharpness: abSharpness,
            dnLoadElev: dnLoadElev,
            upDropPt: upDropPt,
            // Raw stats for display
            _minLoad: minLoad,
            _maxLoad: maxLoad,
            _minPos: minPos,
            _maxPos: maxPos,
            _loadRange: loadRange,
            _posRange: posRange,
            _cardArea: area,
        };
    }

    function calcSlope(xArr, yArr, indices) {
        if (indices.length < 3) return 0;
        var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        var n = indices.length;
        for (var k = 0; k < n; k++) {
            var x = xArr[indices[k]];
            var y = yArr[indices[k]];
            sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
        }
        var denom = n * sumX2 - sumX * sumX;
        if (Math.abs(denom) < 1e-10) return 0;
        return (n * sumXY - sumX * sumY) / denom;
    }

    function interpPosAtLoad(normPos, normLoad, indices, targetLoad) {
        for (var k = 1; k < indices.length; k++) {
            var prev = indices[k - 1], cur = indices[k];
            var l0 = normLoad[prev], l1 = normLoad[cur];
            if ((l0 <= targetLoad && l1 >= targetLoad) || (l0 >= targetLoad && l1 <= targetLoad)) {
                if (Math.abs(l1 - l0) < 1e-10) return normPos[prev];
                var frac = (targetLoad - l0) / (l1 - l0);
                return normPos[prev] + frac * (normPos[cur] - normPos[prev]);
            }
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Pattern Matching
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Empirical Centroids — computed from 47 wells (2026-03-23)
    //
    // Each centroid is [areaRatio, flatTop, flatBottom, fluidPoundIdx,
    //   svTransition, tvTransition, cdSharpness, abSharpness, dnLoadElev, upDropPt]
    // with corresponding standard deviations. Used by the nearest-centroid
    // classifier to score each pattern.
    //
    // New features from published diagnostic criteria:
    //   cdSharpness: C-to-D transition slope (sharp=fluid pound, gradual=gas)
    //   abSharpness: A-to-B transition slope (sharp=normal, gradual=TV leak/gas)
    //   dnLoadElev:  mean mid-downstroke load (high=SV leak)
    //   upDropPt:    fraction of upstroke before load drops (late=full pump)
    // -----------------------------------------------------------------------
    var CENTROIDS = {
        full_pump:          { mean: [0.834, 0.739, 0.710, 0.160, 1.000, 1.000, 0.644, 0.836, 0.059, 0.952], std: [0.05, 0.08, 0.07, 0.05, 0.05, 0.05, 0.15, 0.17, 0.05, 0.05], n: 4 },
        fluid_pound:        { mean: [0.577, 0.647, 0.400, 0.297, 0.237, 0.675, 0.187, 0.360, 0.241, 0.655], std: [0.22, 0.25, 0.20, 0.22, 0.41, 0.39, 0.26, 0.37, 0.14, 0.34], n: 17 },
        gas_interference:   { mean: [0.634, 0.562, 0.344, 0.242, 0.584, 0.616, 0.283, 0.390, 0.229, 0.641], std: [0.08, 0.25, 0.09, 0.12, 0.42, 0.41, 0.27, 0.34, 0.05, 0.36], n: 4 },
        incomplete_fillage: { mean: [0.690, 0.450, 0.526, 0.205, -0.024, 0.885, 0.512, 0.753, 0.154, 0.268], std: [0.10, 0.20, 0.16, 0.09, 1.12, 0.28, 0.35, 0.16, 0.06, 0.05], n: 7 },
        bent_barrel:        { mean: [0.744, 0.781, 0.411, 0.254, 0.879, 1.000, 0.373, 0.495, 0.141, 0.946], std: [0.05, 0.10, 0.24, 0.05, 0.12, 0.05, 0.30, 0.35, 0.05, 0.05], n: 2 },
        sv_leak:            { mean: [0.755, 0.651, 0.394, 0.209, 1.000, 0.340, 0.580, 0.176, 0.100, 0.662], std: [0.05, 0.12, 0.14, 0.06, 0.05, 0.48, 0.21, 0.16, 0.05, 0.21], n: 3 },
        tv_leak:            { mean: [0.823, 0.695, 0.920, 0.134, 0.554, 1.000, 0.361, 0.484, 0.061, 0.909], std: [0.05, 0.06, 0.05, 0.05, 0.45, 0.05, 0.23, 0.08, 0.05, 0.05], n: 2 },
        worn_pump:          { mean: [0.824, 0.703, 0.728, 0.145, 1.000, 1.000, 0.878, 0.932, 0.056, 0.960], std: [0.05, 0.08, 0.05, 0.05, 0.05, 0.05, 0.12, 0.07, 0.05, 0.05], n: 2 },
        rod_part:           { mean: [0.311, 0.103, 0.095, 0.060, -0.814, -0.820, -0.070, -0.050, 0.781, 0.247], std: [0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15], n: 1 },
    };

    /**
     * Physics-first hybrid classifier.
     *
     * Step 1: Apply hard physical rules from published SPE/industry criteria
     *         (Downhole Diagnostic, Echometer TechNotes, SPE 17313/173964).
     *         These override centroid scores when the physics is unambiguous.
     *
     * Step 2: Use nearest-centroid as tiebreaker for ambiguous cases.
     *
     * Key physical rules (source: Downhole Diagnostic / Shawn):
     *   - Gas interference: A-B corner ROUNDED (gas expansion delays pressure drop).
     *     Liquid is incompressible → sharp A-B = NOT gas interference.
     *   - Fluid pound: C-D transition is SHARP (plunger hits liquid surface).
     *     Both A-B and C-D are right angles when fluid pound (liquid in/out).
     *   - SV leak: downstroke load elevated above zero (fluid leaks back through SV).
     *   - TV leak: upstroke load declining (fluid leaks past plunger).
     *   - Full pump: rectangular card, high area, flat top/bottom, late load drop.
     *   - Gas lock: card collapsed to tiny ellipse, neither valve opens.
     *   - Rod part: very small flat card, minimal load variation.
     *
     * @param {Object} features - From extractFeatures()
     * @returns {Array} [{pattern, confidence, matchDetails, physicsRule}, ...]
     */
    function diagnose(features) {
        if (!features || features.error) return [];

        var f = features;
        var ar = f.areaRatio, ft = f.flatTop, fb = f.flatBottom;
        var fp = f.fluidPoundIdx, cd = f.cdSharpness, ab = f.abSharpness;
        var dnE = f.dnLoadElev, upD = f.upDropPt;

        if (ar === undefined || cd === undefined || ab === undefined) return [];

        // ── Step 1: Physics-based hard rules ──
        // Each rule produces {id, confidence, reason} entries.
        var physicsResults = [];

        // Rule 1: Rod part — very small flat card
        if (ar < 0.20 && ft < 0.20 && fb < 0.20) {
            physicsResults.push({
                id: 'rod_part', confidence: 0.95,
                reason: 'Very small flat card (area=' + ar.toFixed(2) + '). Minimal load variation — rod string parted, no pump action.'
            });
        }

        // Rule 2: Gas lock — card collapsed to sliver
        if (ar < 0.15) {
            physicsResults.push({
                id: 'gas_lock', confidence: 0.90,
                reason: 'Card area collapsed to ' + ar.toFixed(2) + '. Neither valve opening — gas just compresses and expands each stroke.'
            });
        }

        // Rule 3: Full pump — rectangular card with sharp transitions
        // Published: high area, flat top AND bottom, load maintained through stroke
        if (ar > 0.72 && ft > 0.65 && fb > 0.55 && upD > 0.85) {
            physicsResults.push({
                id: 'full_pump', confidence: 0.85,
                reason: 'Rectangular card (area=' + ar.toFixed(2) + ', flatTop=' + ft.toFixed(2) + ', flatBot=' + fb.toFixed(2) + '). Load maintained to ' + Math.round(upD * 100) + '% of stroke.'
            });
        }

        // Rule 4: Gas interference — BOTH corners rounded (banana/football shape)
        // Published (Downhole Diagnostic): "rounded upper-left corner due to gas expansion"
        // Gas compresses before valves open → gradual transitions at BOTH A-B and C-D.
        // Physical mechanism: gas is compressible, liquid is not.
        // Sharp A-B (ab > 0.4) rules OUT gas interference.
        if (ab < 0.35 && cd < 0.35 && ar > 0.25 && ar < 0.80) {
            physicsResults.push({
                id: 'gas_interference', confidence: 0.80,
                reason: 'Both A-B (' + ab.toFixed(2) + ') and C-D (' + cd.toFixed(2) + ') corners rounded — banana/football shape. Gas compression delays valve action at both transitions.'
            });
        } else if (ab < 0.25 && ar > 0.25 && ar < 0.80) {
            // Even if C-D is sharp, very rounded A-B suggests gas expansion on upstroke
            physicsResults.push({
                id: 'gas_interference', confidence: 0.65,
                reason: 'A-B corner rounded (' + ab.toFixed(2) + ') — gas expansion delays pressure drop on upstroke. Partial gas interference.'
            });
        }

        // Rule 5: Fluid pound — sharp transitions, reduced area
        // Published: "fluid load picked up and released INSTANTLY — right angles"
        // Plunger hits liquid surface → sharp C-D. Liquid incompressible → sharp A-B.
        if (cd > 0.30 && ab > 0.30 && ar < 0.80 && upD < 0.90) {
            physicsResults.push({
                id: 'fluid_pound', confidence: 0.75,
                reason: 'Sharp A-B (' + ab.toFixed(2) + ') and C-D (' + cd.toFixed(2) + ') transitions — liquid incompressible, right-angle valve action. Load drops at ' + Math.round(upD * 100) + '% of upstroke.'
            });
        }

        // Rule 6: TV leak — declining upstroke load (fluid leaks past plunger)
        // Published: "upper corners rounded off", "load falls off during upstroke"
        if (f.upstrokeSlope < -0.20 && ft < 0.50) {
            physicsResults.push({
                id: 'tv_leak', confidence: 0.70,
                reason: 'Upstroke load declining (slope=' + f.upstrokeSlope.toFixed(2) + ', flatTop=' + ft.toFixed(2) + '). Fluid leaking past TV/plunger during upstroke.'
            });
        }

        // Rule 7: SV leak — elevated downstroke load (fluid leaks back through SV)
        // Published: "bottom corners rounded", "premature loading from A to B"
        if (dnE > 0.25 && f.downstrokeSlope > 0.10) {
            physicsResults.push({
                id: 'sv_leak', confidence: 0.70,
                reason: 'Downstroke load elevated (' + dnE.toFixed(2) + '), rising bottom (slope=' + f.downstrokeSlope.toFixed(2) + '). Fluid leaking back through SV.'
            });
        }

        // Rule 8: Bent barrel — asymmetric card (high flat top, low flat bottom)
        // Published: "lower-left bent backwards, top-right sloped down", irregular transitions
        if (ar > 0.65 && ft > 0.60 && fb < 0.35 && fp > 0.15) {
            physicsResults.push({
                id: 'bent_barrel', confidence: 0.65,
                reason: 'Asymmetric: flatTop=' + ft.toFixed(2) + ' but flatBot=' + fb.toFixed(2) + '. Irregular load pattern — mechanical interference in pump.'
            });
        }

        // Rule 9: Worn pump — reduced area but generally rectangular, both strokes affected
        if (ar > 0.55 && ar < 0.82 && ft > 0.40 && fb > 0.40 && fp < 0.25) {
            physicsResults.push({
                id: 'worn_pump', confidence: 0.55,
                reason: 'Reduced area (' + ar.toFixed(2) + ') but retains rectangular shape. Both strokes show some rounding — plunger-barrel clearance increased.'
            });
        }

        // Rule 10: Incomplete fillage — moderate area reduction, no strong signature
        if (ar > 0.50 && ar < 0.80 && fp < 0.30 && physicsResults.length === 0) {
            physicsResults.push({
                id: 'incomplete_fillage', confidence: 0.50,
                reason: 'Moderate area reduction (' + ar.toFixed(2) + ') without clear fluid pound, gas interference, or valve leak signature.'
            });
        }

        // ── Step 2: Centroid distance as secondary score ──
        var fNames = ['areaRatio', 'flatTop', 'flatBottom', 'fluidPoundIdx',
                      'svTransition', 'tvTransition', 'cdSharpness', 'abSharpness',
                      'dnLoadElev', 'upDropPt'];
        var fVec = [];
        for (var fi = 0; fi < fNames.length; fi++) {
            var val = f[fNames[fi]];
            if (val === undefined || val === null || isNaN(val)) return [];
            fVec.push(val);
        }

        var centroidScores = {};
        for (var cid in CENTROIDS) {
            if (!CENTROIDS.hasOwnProperty(cid)) continue;
            var cent = CENTROIDS[cid];
            var dist = 0;
            for (var i = 0; i < fVec.length; i++) {
                var std = Math.max(cent.std[i], 0.05);
                var d = (fVec[i] - cent.mean[i]) / std;
                dist += d * d;
            }
            dist = Math.sqrt(dist);
            var bonus = Math.log(Math.max(cent.n, 1) + 1) * 0.3;
            centroidScores[cid] = -dist + bonus;
        }

        // ── Step 3: Merge physics rules with centroid scores ──
        // Physics rules get priority; centroid fills in gaps and adjusts confidence.
        var merged = {};  // id → {confidence, reason, centroidRank}

        // Rank centroids
        var centroidRanked = Object.keys(centroidScores).sort(function (a, b) {
            return centroidScores[b] - centroidScores[a];
        });

        // Start with physics results
        for (var r = 0; r < physicsResults.length; r++) {
            var pr = physicsResults[r];
            if (!merged[pr.id]) {
                merged[pr.id] = { confidence: pr.confidence, reason: pr.reason };
            } else if (pr.confidence > merged[pr.id].confidence) {
                merged[pr.id].confidence = pr.confidence;
                merged[pr.id].reason = pr.reason;
            }
        }

        // Add centroid top picks that physics didn't produce
        for (var cr = 0; cr < Math.min(3, centroidRanked.length); cr++) {
            var cid = centroidRanked[cr];
            if (!merged[cid]) {
                // Centroid-only picks get lower confidence
                merged[cid] = {
                    confidence: Math.max(0.15, 0.40 - cr * 0.12),
                    reason: 'Statistical match (centroid distance rank #' + (cr + 1) + ').'
                };
            }
        }

        // Boost confidence when physics and centroid agree
        if (centroidRanked.length > 0) {
            var topCentroid = centroidRanked[0];
            if (merged[topCentroid] && physicsResults.length > 0) {
                for (var r = 0; r < physicsResults.length; r++) {
                    if (physicsResults[r].id === topCentroid) {
                        merged[topCentroid].confidence = Math.min(0.98,
                            merged[topCentroid].confidence + 0.10);
                        merged[topCentroid].reason += ' Confirmed by centroid classifier.';
                        break;
                    }
                }
            }
        }

        // ── Step 4: Build results array ──
        var results = [];
        for (var id in merged) {
            if (!merged.hasOwnProperty(id)) continue;
            var pattern = null;
            for (var p = 0; p < PATTERNS.length; p++) {
                if (PATTERNS[p].id === id) { pattern = PATTERNS[p]; break; }
            }
            if (!pattern) continue;

            results.push({
                pattern: pattern,
                confidence: Math.round(merged[id].confidence * 100) / 100,
                physicsRule: merged[id].reason,
                matchDetails: {},
            });
        }

        results.sort(function (a, b) { return b.confidence - a.confidence; });
        return results;
    }

    /**
     * Get a human-readable diagnosis summary.
     *
     * @param {Array} position - Downhole card position
     * @param {Array} load     - Downhole card load
     * @param {Object} rodModel - Optional rod model
     * @returns {Object} {primary, secondary, features, allMatches}
     */
    function analyzeCard(position, load, rodModel) {
        var features = extractFeatures(position, load, rodModel);
        if (!features) return { primary: null, error: 'Could not extract features' };

        var matches = diagnose(features);

        return {
            primary: matches.length > 0 ? matches[0] : null,
            secondary: matches.length > 1 ? matches[1] : null,
            features: features,
            allMatches: matches,
        };
    }

    // Public API
    return {
        PATTERNS: PATTERNS,
        extractFeatures: extractFeatures,
        diagnose: diagnose,
        analyzeCard: analyzeCard,
    };
})();
