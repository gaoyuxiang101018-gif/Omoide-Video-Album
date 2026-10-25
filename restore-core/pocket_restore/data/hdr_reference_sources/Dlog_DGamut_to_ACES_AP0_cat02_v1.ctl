// <ACEStransformID>urn:ampas:aces:transformId:v1.5:IDT.DJI.DLog_DGamut.a1.v1</ACEStransformID> 
// <ACESuserName>ACES 1.0 Input - DJI DLog DGamut</ACESuserName> 
//
// IDT for DLog DGamut by DJI

import "ACESlib.Utilities_Color";

const Chromaticities DGamut_PRI = 
{
  { 0.71,    0.31},
  { 0.21,    0.88},
  { 0.09,    -0.08},
  { 0.3127,  0.3290}
};


const float DGamut_TO_AP0_MAT[3][3] = 
                        calculate_rgb_to_rgb_matrix( DGamut_PRI,
                                                     AP0,
                                                     CONE_RESP_MAT_CAT02 );

float dlog_to_lin(float x) {
	if (x <= 0.14)
		return (x - 0.0929) / 6.025;
	else
		return (pow(10, (3.89616 * x - 2.27752)) - 0.0108) / 0.9892;
}

void main
	(
	input varying float rIn,
	input varying float gIn,
	input varying float bIn,
	input varying float aIn,
	output varying float rOut,
	output varying float gOut,
	output varying float bOut,
	output varying float aOut)

{
   float lin_rgb[3];
   lin_rgb[0] = dlog_to_lin(rIn);
   lin_rgb[1] = dlog_to_lin(gIn);
   lin_rgb[2] = dlog_to_lin(bIn);

   float ACES[3] = mult_f3_f33(lin_rgb, DGamut_TO_AP0_MAT);

   rOut = ACES[0];
   gOut = ACES[1];
   bOut = ACES[2];   
   aOut = aIn;
}